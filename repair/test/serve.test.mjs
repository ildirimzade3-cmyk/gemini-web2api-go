import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ATTACHMENTS, RequestError, createBrowserServer, validateGenerateBody } from '../serve.mjs';
import { UiError } from '../session.mjs';

const TOKEN = 'browser-token-for-tests';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake session: `ask` is steered by the test; it records concurrency and call order. */
function fakeSession(ask) {
  const state = { running: 0, maxRunning: 0, order: [], requests: [] };
  return {
    state,
    status: () => ({ ready: true, signed_in: true }),
    ask: async (req) => {
      state.requests.push(req);
      state.running++;
      state.maxRunning = Math.max(state.maxRunning, state.running);
      try {
        return await (ask ? ask(req, state) : { text: `echo:${req.prompt}`, model_label_seen: 'Flash-Lite' });
      } finally {
        state.running--;
      }
    },
  };
}

async function start(session, opts = {}) {
  const logs = [];
  const srv = createBrowserServer({ session, token: TOKEN, log: (step, f) => logs.push({ step, ...f }), ...opts });
  const port = await srv.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${port}`;
  const post = (body, headers = {}) =>
    fetch(`${url}/generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { srv, url, post, logs, close: () => srv.close() };
}

test('validateGenerateBody accepts the documented request and normalises it', () => {
  const r = validateGenerateBody({
    prompt: 'hi',
    model_label: ' 3.5 Flash-Lite ',
    json: true,
    attachments: [{ name: '../dir\\notes.txt', mime: 'text/plain', data_b64: Buffer.from('abc').toString('base64') }, { name: 'a.bin', data_b64: 'AQID' }],
  });
  assert.equal(r.prompt, 'hi');
  assert.equal(r.modelLabel, '3.5 Flash-Lite');
  assert.equal(r.json, true);
  assert.equal(r.attachments[0].name, 'notes.txt');
  assert.equal(r.attachments[0].data.toString(), 'abc');
  assert.equal(r.attachments[1].mime, 'application/octet-stream');
  assert.deepEqual(validateGenerateBody({ prompt: 'x' }), { prompt: 'x', modelLabel: undefined, attachments: [], json: false });
});

test('validateGenerateBody rejects malformed requests with invalid_request', () => {
  const ok = { name: 'a', data_b64: 'AQID' };
  const bad = [
    null,
    [],
    'text',
    {},
    { prompt: '   ' },
    { prompt: 5 },
    { prompt: 'x', model_label: 5 },
    { prompt: 'x', model_label: 'm'.repeat(101) },
    { prompt: 'x', json: 'yes' },
    { prompt: 'x', attachments: 'nope' },
    { prompt: 'x', attachments: Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ok) },
    { prompt: 'x', attachments: [null] },
    { prompt: 'x', attachments: [{ data_b64: 'AQID' }] },
    { prompt: 'x', attachments: [{ name: 'a', data_b64: 'not base64 !!' }] },
    { prompt: 'x', attachments: [{ name: 'a', data_b64: '' }] },
    { prompt: 'x', attachments: [{ name: 'a', mime: 5, data_b64: 'AQID' }] },
  ];
  for (const b of bad) {
    assert.throws(() => validateGenerateBody(b), (e) => e instanceof RequestError && e.code === 'invalid_request', JSON.stringify(b)?.slice(0, 80));
  }
});

test('POST /generate returns text, model_label_seen and elapsed_ms', async () => {
  const s = await start(fakeSession());
  const res = await s.post({ prompt: 'ping', model_label: 'Flash-Lite' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.text, 'echo:ping');
  assert.equal(body.model_label_seen, 'Flash-Lite');
  assert.equal(typeof body.elapsed_ms, 'number');
  await s.close();
});

test('authorization: missing, malformed and wrong tokens get 401 before the body is read; healthz is open', async () => {
  const session = fakeSession();
  const s = await start(session);
  for (const headers of [{ authorization: '' }, { authorization: 'Bearer' }, { authorization: 'Bearer wrong' }, { authorization: `Basic ${TOKEN}` }]) {
    const res = await s.post({ prompt: 'x' }, headers);
    assert.equal(res.status, 401, JSON.stringify(headers));
    assert.equal((await res.json()).error.code, 'unauthorized');
  }
  assert.equal(session.state.requests.length, 0);
  const health = await fetch(`${s.url}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, signed_in: true, queue: 0 });
  await s.close();
});

test('createBrowserServer refuses to run without a token', () => {
  assert.throws(() => createBrowserServer({ session: fakeSession(), token: '' }), /token/);
});

test('routing: unknown path 404, GET /generate 400, malformed and oversized bodies', async () => {
  const s = await start(fakeSession(), { maxBodyBytes: 200 });
  assert.equal((await fetch(`${s.url}/nope`)).status, 404);
  assert.equal((await fetch(`${s.url}/generate`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 400);
  const notJson = await s.post('{broken');
  assert.equal(notJson.status, 400);
  assert.equal((await notJson.json()).error.code, 'invalid_request');
  const tooBig = await s.post({ prompt: 'x'.repeat(500) });
  assert.equal(tooBig.status, 413);
  assert.equal((await tooBig.json()).error.code, 'payload_too_large');
  assert.equal((await s.post({ prompt: '' })).status, 400);
  await s.close();
});

test('requests are serialised: never two at once, strictly in arrival order', async () => {
  const session = fakeSession(async (req, state) => {
    state.order.push(`start:${req.prompt}`);
    await sleep(60);
    state.order.push(`end:${req.prompt}`);
    return { text: req.prompt, model_label_seen: '' };
  });
  const s = await start(session);
  const first = s.post({ prompt: 'a' });
  await sleep(15);
  const rest = [s.post({ prompt: 'b' }), s.post({ prompt: 'c' })];
  await sleep(15);
  assert.equal(s.srv.queueDepth(), 3);
  const health = await (await fetch(`${s.url}/healthz`)).json();
  assert.equal(health.queue, 3);
  const bodies = await Promise.all([first, ...rest].map(async (p) => (await p).json()));
  assert.deepEqual(bodies.map((b) => b.text), ['a', 'b', 'c']);
  assert.equal(session.state.maxRunning, 1);
  assert.deepEqual(session.state.order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  assert.equal(s.srv.queueDepth(), 0);
  await s.close();
});

test('a failing request does not block the queue', async () => {
  let n = 0;
  const s = await start(
    fakeSession(async (req) => {
      if (n++ === 0) throw new UiError('upstream_unavailable', 'boom');
      return { text: 'fine', model_label_seen: '' };
    }),
  );
  const [bad, good] = await Promise.all([s.post({ prompt: 'a' }), s.post({ prompt: 'b' })]);
  assert.equal(bad.status, 503);
  assert.equal(good.status, 200);
  await s.close();
});

test('error codes map to the bridge vocabulary: 429, 503 and 400', async () => {
  const cases = [
    ['upstream_rate_limited', 429],
    ['upstream_unavailable', 503],
    ['upstream_protocol_changed', 503],
    ['no_valid_account', 503],
    ['model_not_found', 400],
  ];
  for (const [code, status] of cases) {
    const s = await start(
      fakeSession(async () => {
        throw new UiError(code, `message for ${code}`);
      }),
    );
    const res = await s.post({ prompt: 'x' });
    assert.equal(res.status, status, code);
    assert.deepEqual(await res.json(), { error: { code, message: `message for ${code}` } });
    await s.close();
  }
});

test('an unexpected exception becomes a generic 503 upstream_unavailable without leaking its message', async () => {
  const s = await start(
    fakeSession(async () => {
      throw new TypeError('secret internal detail');
    }),
  );
  const res = await s.post({ prompt: 'x' });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: { code: 'upstream_unavailable', message: 'internal error' } });
  await s.close();
});

test('a full queue answers 503 upstream_unavailable immediately', async () => {
  const gate = [];
  const session = fakeSession(() => new Promise((r) => gate.push(r)));
  const s = await start(session, { maxQueue: 2 });
  const held = [s.post({ prompt: 'a' }), s.post({ prompt: 'b' })];
  await sleep(40);
  const res = await s.post({ prompt: 'c' });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error.message, /queue is full/);
  // The second job only reaches the session once the first has finished.
  for (let i = 0; i < 2; i++) {
    gate.splice(0).forEach((r) => r({ text: 'ok', model_label_seen: '' }));
    await sleep(40);
  }
  assert.deepEqual(await Promise.all(held.map(async (p) => (await p).status)), [200, 200]);
  await s.close();
});

test('the request ceiling and the parsed request reach the session', async () => {
  const session = fakeSession();
  const s = await start(session, { ceilingMs: 123000 });
  await s.post({ prompt: 'p', model_label: 'M', json: true, attachments: [{ name: 'f.txt', mime: 'text/plain', data_b64: 'AQID' }] });
  const req = session.state.requests[0];
  assert.equal(req.ceilingMs, 123000);
  assert.equal(req.modelLabel, 'M');
  assert.equal(req.json, true);
  assert.deepEqual(req.attachments[0].data, Buffer.from([1, 2, 3]));
  await s.close();
});

test('a client that went away while queued is skipped', async () => {
  const gate = [];
  const session = fakeSession(() => new Promise((r) => gate.push(r)));
  const s = await start(session);
  const first = s.post({ prompt: 'a' });
  await sleep(30);
  const ctrl = new AbortController();
  const second = fetch(`${s.url}/generate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'b' }),
    signal: ctrl.signal,
  }).catch(() => null);
  await sleep(30);
  ctrl.abort();
  await sleep(30);
  gate[0]({ text: 'ok', model_label_seen: '' });
  await (await first).json();
  await second;
  await sleep(30);
  assert.equal(session.state.requests.length, 1, 'the aborted request never reached the browser');
  assert.equal(s.srv.queueDepth(), 0);
  await s.close();
});

test('logs carry lengths and a hash, never the prompt or the answer', async () => {
  const s = await start(fakeSession(async () => ({ text: 'ANSWER-SECRET-TEXT', model_label_seen: '' })));
  await s.post({ prompt: 'PROMPT-SECRET-TEXT' });
  await s.close();
  const dump = JSON.stringify(s.logs);
  assert.ok(!dump.includes('PROMPT-SECRET-TEXT'));
  assert.ok(!dump.includes('ANSWER-SECRET-TEXT'));
  const req = s.logs.find((l) => l.step === 'request');
  assert.equal(req.prompt_chars, 18);
  assert.match(req.prompt_sha256, /^[0-9a-f]{12}$/);
  assert.equal(s.logs.find((l) => l.step === 'response').answer_chars, 18);
});

test('idle exit fires after idleExitMs without /generate requests; healthz does not keep it alive', async () => {
  let idle = 0;
  const s = await start(fakeSession(), { idleExitMs: 200, onIdle: () => idle++ });
  for (let i = 0; i < 4; i++) {
    await sleep(60);
    await fetch(`${s.url}/healthz`);
  }
  await sleep(150);
  assert.equal(idle, 1);
  await sleep(300);
  assert.equal(idle, 1, 'fires once');
  await s.close();
});

test('idle exit is pushed back by requests and never fires while a request is running', async () => {
  let idle = 0;
  const session = fakeSession(async () => {
    await sleep(350);
    return { text: 'slow', model_label_seen: '' };
  });
  const s = await start(session, { idleExitMs: 150, onIdle: () => idle++ });
  await sleep(100);
  assert.equal((await s.post({ prompt: 'slow' })).status, 200);
  assert.equal(idle, 0, 'a 350 ms request with a 150 ms idle limit must not trigger it');
  await sleep(100);
  assert.equal(idle, 0, 'the idle clock restarted when the request ended');
  await sleep(250);
  assert.equal(idle, 1);
  await s.close();
});
