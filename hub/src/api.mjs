// The address every app uses: OpenAI-compatible (/v1/chat/completions, /v1/models)
// and Gemini-compatible (/v1beta/models/{model}:generateContent and
// :streamGenerateContent). Only reachable from allowlisted networks; every request
// needs an app key that is bound to the caller's source network.

import http from 'node:http';
import crypto from 'node:crypto';
import { authenticate, AuthThrottle, ipInCidrs, normalizeIp, parseCidr, sha256 } from './security.mjs';
import { RequestError, buildPrompt, fromGemini, fromOpenAI, geminiJson, openAIJson } from './prompt.mjs';
import { HubError } from './scheduler.mjs';

const MAX_BODY = 60 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new RequestError('request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Many HTTP clients give up when no response header arrives within 300 s (Node's
 * fetch, some proxies). A request still waiting after `holdMs` (240 s) gets its headers
 * now and a heartbeat until the answer: blank lines are valid leading JSON
 * whitespace, ": waiting" lines are SSE comments. Errors after that point arrive
 * in the body (status already 200), with x-hub-held: 1 telling the client why.
 */
function holdOpen(res, sse, holdMs) {
  let beat = null;
  const timer = setTimeout(() => {
    if (res.headersSent || res.writableEnded) return;
    res.hubHeld = sse ? 'sse' : 'json';
    res.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/json', 'cache-control': 'no-store', 'x-hub-held': '1' });
    const tick = () => !res.writableEnded && res.write(sse ? ': waiting\n\n' : '\n');
    tick();
    beat = setInterval(tick, 15_000);
  }, holdMs);
  return () => {
    clearTimeout(timer);
    clearInterval(beat);
  };
}

function send(res, status, obj, headers = {}) {
  if (res.hubHeld === 'json' && !res.writableEnded) return res.end(JSON.stringify(obj));
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

const STATUS_NAME = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 409: 'ABORTED', 429: 'RESOURCE_EXHAUSTED', 502: 'UNAVAILABLE', 503: 'UNAVAILABLE' };

function errorBody(flavor, status, code, message) {
  if (flavor === 'gemini') return { error: { code: status, message, status: STATUS_NAME[status] ?? 'INTERNAL', details: [{ reason: code }] } };
  return { error: { message, type: status === 429 ? 'rate_limit_error' : status < 500 ? 'invalid_request_error' : 'server_error', code } };
}

function estTokens(chars) {
  return Math.max(1, Math.ceil(chars / 4));
}

export class ApiServer {
  constructor({ config, store, scheduler, log }) {
    Object.assign(this, { config, store, scheduler, log });
    this.allow = config.allowCidrs.map(parseCidr);
    this.throttle = new AuthThrottle();
    this.servers = [];
  }

  async start() {
    for (const addr of this.config.apiListen) this.#listen(addr);
  }

  #listen(addr) {
    const i = addr.lastIndexOf(':');
    const host = addr.slice(0, i).replace(/^\[|\]$/g, '');
    const port = Number(addr.slice(i + 1));
    const server = http.createServer({ requestTimeout: 0, headersTimeout: 30_000, keepAliveTimeout: 65_000 }, (req, res) =>
      this.#handle(req, res).catch((e) => {
        this.log('api_error', { error: e.message });
        send(res, 500, errorBody('openai', 500, 'internal', 'internal error'));
      }),
    );
    server.on('connection', (sock) => {
      // Network allowlist before a single byte is read.
      if (!ipInCidrs(normalizeIp(sock.remoteAddress), this.allow)) sock.destroy();
    });
    server.on('error', (e) => {
      this.log('api_listen_retry', { addr, error: e.code || e.message });
      setTimeout(() => server.listen(port, host), 30_000);
    });
    server.listen(port, host, () => this.log('api_listening', { addr }));
    this.servers.push(server);
  }

  async stop() {
    await Promise.all(this.servers.map((s) => new Promise((r) => s.close(r))));
  }

  async #handle(req, res) {
    const ip = normalizeIp(req.socket.remoteAddress);
    const url = new URL(req.url, 'http://hub');
    const flavor = url.pathname.startsWith('/v1beta') ? 'gemini' : 'openai';
    const fail = (status, code, message, headers) => send(res, status, errorBody(flavor, status, code, message), headers);

    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (this.throttle.blocked(ip)) return fail(429, 'blocked', 'too many failed authentications', { 'retry-after': '1800' });
    const auth = authenticate(this.store, req, url, ip);
    if (!auth.app) {
      this.throttle.fail(ip);
      this.store.event('warn', 'auth_failed', null, { ip, reason: auth.reason, app: auth.app_id ?? null });
      return fail(401, 'unauthenticated', auth.error);
    }
    this.throttle.ok(ip);
    const app = auth.app;

    try {
      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/v1beta/models')) return this.#models(res, app, flavor);
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return await this.#openai(req, res, app);
      const m = /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/.exec(url.pathname);
      if (req.method === 'POST' && m) return await this.#gemini(req, res, app, decodeURIComponent(m[1]), m[2] === 'streamGenerateContent', url);
      return fail(404, 'not_found', 'unknown endpoint');
    } catch (e) {
      if (e instanceof RequestError) return fail(400, e.code, e.message);
      if (e instanceof HubError) {
        const headers = e.retryAfter ? { 'retry-after': String(e.retryAfter) } : {};
        if (res.hubHeld === 'json') return send(res, e.status, errorBody(flavor, e.status, e.code, e.message));
        if (res.headersSent) return this.#streamError(res, flavor, e);
        return fail(e.status, e.code, e.message, headers);
      }
      throw e;
    }
  }

  #visibleModels(app) {
    const cat = this.scheduler.catalogue();
    const allowed = app.models === '*' ? null : new Set(app.models.split(',').map((s) => s.trim()));
    return Object.values(cat).filter((m) => !allowed || allowed.has(m.id));
  }

  #models(res, app, flavor) {
    const list = this.#visibleModels(app);
    if (flavor === 'gemini') {
      return send(res, 200, {
        models: list.map((m) => ({ name: `models/${m.id}`, displayName: m.label, supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] })),
      });
    }
    return send(res, 200, { object: 'list', data: list.map((m) => ({ id: m.id, object: 'model', owned_by: 'gemini-hub', created: 0 })) });
  }

  #dedupeKey(app, req, model, raw) {
    const idem = req.headers['idempotency-key'];
    if (idem) return sha256(`${app.id}\0idem\0${idem}`);
    return sha256(`${app.id}\0${model}\0${raw.toString('base64')}`);
  }

  #meta(result) {
    return {
      'x-hub-model': result.model,
      'x-hub-model-label': result.label,
      'x-hub-account': result.account,
      'x-hub-deduplicated': result.deduplicated ? '1' : '0',
    };
  }

  async #openai(req, res, app) {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new RequestError('body is not JSON');
    }
    if (typeof body.model !== 'string' || !body.model) throw new RequestError('model is required');
    if (body.n != null && body.n !== 1) throw new RequestError('n must be 1');
    const json = openAIJson(body);
    const prompt = buildPrompt(fromOpenAI(body), json);
    const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);
    const stream = body.stream === true;
    let sentText = '';
    const chunk = (delta, finish = null) =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const onProgress = stream && !json
      ? (text) => {
          if (!res.headersSent) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
            res.write(chunk({ role: 'assistant', content: '' }));
          }
          if (text.startsWith(sentText) && text.length > sentText.length) {
            res.write(chunk({ content: text.slice(sentText.length) }));
            sentText = text;
          }
        }
      : null;
    const release = holdOpen(res, stream, this.config.holdMs ?? 240_000);
    const result = await this.scheduler.submit({
      app,
      model: body.model,
      prompt,
      json,
      onProgress,
      dedupeKey: this.#dedupeKey(app, req, body.model, raw),
      inChars: prompt.text.length,
    }).finally(release);
    const usage = { prompt_tokens: estTokens(prompt.text.length), completion_tokens: estTokens(result.text.length) };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    if (stream) {
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', ...this.#meta(result) });
        res.write(chunk({ role: 'assistant', content: '' }));
      }
      // The final text is Google's markdown; finish with whatever the live view had not shown yet.
      const rest = result.text.startsWith(sentText) ? result.text.slice(sentText.length) : '';
      if (rest) res.write(chunk({ content: rest }));
      res.write(chunk({}, 'stop'));
      if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    send(
      res,
      200,
      {
        id,
        object: 'chat.completion',
        created,
        model: result.model,
        choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
        usage,
      },
      this.#meta(result),
    );
  }

  async #gemini(req, res, app, model, stream, url) {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new RequestError('body is not JSON');
    }
    const json = geminiJson(body);
    const prompt = buildPrompt(fromGemini(body), json);
    const sse = stream && url.searchParams.get('alt') === 'sse';
    let sentText = '';
    const piece = (text, finish) => {
      const c = { candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0, ...(finish ? { finishReason: 'STOP' } : {}) }], modelVersion: model };
      return c;
    };
    const onProgress = sse && !json
      ? (text) => {
          if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
          if (text.startsWith(sentText) && text.length > sentText.length) {
            res.write(`data: ${JSON.stringify(piece(text.slice(sentText.length), false))}\n\n`);
            sentText = text;
          }
        }
      : null;
    const release = holdOpen(res, sse, this.config.holdMs ?? 240_000);
    const result = await this.scheduler
      .submit({ app, model, prompt, json, onProgress, dedupeKey: this.#dedupeKey(app, req, model, raw), inChars: prompt.text.length })
      .finally(release);
    const usageMetadata = { promptTokenCount: estTokens(prompt.text.length), candidatesTokenCount: estTokens(result.text.length) };
    usageMetadata.totalTokenCount = usageMetadata.promptTokenCount + usageMetadata.candidatesTokenCount;
    if (sse) {
      if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', ...this.#meta(result) });
      const rest = result.text.startsWith(sentText) ? result.text.slice(sentText.length) : '';
      res.end(`data: ${JSON.stringify({ ...piece(rest, true), usageMetadata })}\n\n`);
      return;
    }
    const full = { ...piece(result.text, true), usageMetadata };
    send(res, 200, stream ? [full] : full, this.#meta(result));
  }

  #streamError(res, flavor, e) {
    const payload = errorBody(flavor, e.status, e.code, e.message);
    res.end(`data: ${JSON.stringify(payload)}\n\n${flavor === 'openai' ? 'data: [DONE]\n\n' : ''}`);
  }
}
