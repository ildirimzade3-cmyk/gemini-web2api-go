// HTTP front of the browser transport (`serve` mode). Requests are validated,
// authenticated and run one at a time through a queue on a session object:
//
//   session.ask({ prompt, modelLabel, attachments, json, ceilingMs })
//       -> { text, model_label_seen, json_valid? }   (throws errors with a .code)
//   session.status() -> { ready, signed_in }
//
// BrowserSession (session.mjs) is the real implementation; tests use a fake one.
// Prompts and answers are never logged, only their length and a short hash.

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

export const MAX_ATTACHMENTS = 8;
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

const STATUS_BY_CODE = {
  invalid_request: 400,
  model_not_found: 400,
  unauthorized: 401,
  payload_too_large: 413,
  upstream_rate_limited: 429,
  upstream_unavailable: 503,
  upstream_protocol_changed: 503,
  no_valid_account: 503,
};

export class RequestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const bad = (message) => new RequestError('invalid_request', message);

/** Validates a POST /generate body; returns the normalised request. Throws RequestError. */
export function validateGenerateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be a JSON object');
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw bad('prompt must be a non-empty string');
  if (body.model_label != null && (typeof body.model_label !== 'string' || body.model_label.length > 100)) {
    throw bad('model_label must be a string of at most 100 characters');
  }
  if (body.json != null && typeof body.json !== 'boolean') throw bad('json must be a boolean');
  const attachments = [];
  if (body.attachments != null) {
    if (!Array.isArray(body.attachments) || body.attachments.length > MAX_ATTACHMENTS) {
      throw bad(`attachments must be an array of at most ${MAX_ATTACHMENTS} files`);
    }
    for (const a of body.attachments) {
      if (!a || typeof a !== 'object') throw bad('attachment must be an object');
      if (typeof a.name !== 'string' || !a.name.trim() || a.name.length > 120) throw bad('attachment name must be a string of 1-120 characters');
      if (a.mime != null && (typeof a.mime !== 'string' || a.mime.length > 100)) throw bad('attachment mime must be a string');
      if (typeof a.data_b64 !== 'string' || !/^[A-Za-z0-9+/=\s]*$/.test(a.data_b64)) throw bad('attachment data_b64 must be base64');
      const data = Buffer.from(a.data_b64, 'base64');
      if (data.length === 0) throw bad('attachment is empty');
      attachments.push({
        name: a.name.replace(/^.*[\\/]/, '').replace(/[\x00-\x1f:*?"<>|]/g, '_').trim() || 'file',
        mime: a.mime || 'application/octet-stream',
        data,
      });
    }
  }
  return {
    prompt: body.prompt,
    modelLabel: body.model_label ? body.model_label.trim() : undefined,
    attachments,
    json: body.json === true,
  };
}

const digest = (s) => createHash('sha256').update(s).digest();

function authorized(header, token) {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  return Boolean(m) && timingSafeEqual(digest(m[1]), digest(token));
}

/**
 * opts: { session, token, idleExitMs, onIdle, maxQueue = 32, ceilingMs, log, now = Date.now,
 *         maxBodyBytes = MAX_BODY_BYTES }
 * Returns { server, listen(port, host), close(), queueDepth() }.
 */
export function createBrowserServer(opts) {
  const {
    session,
    token,
    idleExitMs = 30 * 60_000,
    onIdle = () => {},
    maxQueue = 32,
    ceilingMs,
    log = () => {},
    now = Date.now,
    maxBodyBytes = MAX_BODY_BYTES,
  } = opts;
  if (!token) throw new Error('a bearer token is required');

  let tail = Promise.resolve();
  let depth = 0;
  let lastActivity = now();
  let idleTimer = null;

  /** Runs `job` after every earlier job; depth counts waiting plus running jobs. */
  function enqueue(job) {
    depth++;
    const run = tail.then(job);
    tail = run.then(
      () => {},
      () => {},
    ).then(() => {
      depth--;
      lastActivity = now();
    });
    return run;
  }

  function send(res, status, obj) {
    const text = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  }
  const sendError = (res, code, message) => send(res, STATUS_BY_CODE[code] ?? 503, { error: { code, message } });

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > maxBodyBytes) throw new RequestError('payload_too_large', 'request body is too large');
      chunks.push(c);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw bad('body is not valid JSON');
    }
  }

  async function generate(req, res) {
    if (!authorized(req.headers.authorization, token)) return sendError(res, 'unauthorized', 'missing or wrong bearer token');
    lastActivity = now();
    const id = randomUUID().slice(0, 8);
    let aborted = false;
    res.on('close', () => {
      if (!res.writableEnded) aborted = true;
    });
    try {
      const request = validateGenerateBody(await readBody(req));
      if (depth >= maxQueue) throw new RequestError('upstream_unavailable', 'request queue is full');
      log('request', {
        id,
        queue: depth,
        prompt_chars: request.prompt.length,
        prompt_sha256: createHash('sha256').update(request.prompt).digest('hex').slice(0, 12),
        attachments: request.attachments.length,
        model_label: request.modelLabel,
        json: request.json,
      });
      const result = await enqueue(async () => {
        if (aborted) return null;
        const started = now();
        const out = await session.ask({ ...request, ceilingMs });
        return { ...out, elapsed_ms: now() - started };
      });
      if (!result) return log('skipped_aborted', { id });
      log('response', { id, status: 200, elapsed_ms: result.elapsed_ms, answer_chars: result.text.length });
      send(res, 200, result);
    } catch (e) {
      const code = e instanceof RequestError || e.code in STATUS_BY_CODE ? e.code : 'upstream_unavailable';
      const message = code === e.code ? e.message : 'internal error';
      log('response', { id, status: STATUS_BY_CODE[code], code, error: String(e.message).split('\n')[0].slice(0, 200), diagnostic: e.diagnostic });
      if (!res.headersSent) sendError(res, code, message);
    }
  }

  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/healthz' && req.method === 'GET') {
      const st = session.status();
      return send(res, 200, { ok: Boolean(st.ready), signed_in: Boolean(st.signed_in), queue: depth });
    }
    if (path === '/generate') {
      if (req.method !== 'POST') return sendError(res, 'invalid_request', 'use POST');
      return generate(req, res).catch((e) => {
        log('handler_crashed', { error: String(e.message).slice(0, 200) });
        if (!res.headersSent) sendError(res, 'upstream_unavailable', 'internal error');
      });
    }
    send(res, 404, { error: { code: 'not_found', message: 'unknown path' } });
  });

  function startIdleWatch() {
    const every = Math.min(10_000, Math.max(25, Math.floor(idleExitMs / 4)));
    idleTimer = setInterval(() => {
      if (depth === 0 && now() - lastActivity >= idleExitMs) {
        clearInterval(idleTimer);
        idleTimer = null;
        onIdle();
      }
    }, every);
    idleTimer.unref();
  }

  return {
    server,
    queueDepth: () => depth,
    /** Resolves with the bound port. */
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          lastActivity = now();
          startIdleWatch();
          resolve(server.address().port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        if (idleTimer) clearInterval(idleTimer);
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
