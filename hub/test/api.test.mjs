import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Store } from '../src/db.mjs';
import { ApiServer } from '../src/api.mjs';
import { HubError } from '../src/scheduler.mjs';
import { randomToken, sha256 } from '../src/security.mjs';

const CATALOGUE = {
  'gemini-3.1-pro': { id: 'gemini-3.1-pro', label: '3.1 Pro', class: 'pro', accounts: ['a1'] },
  'gemini-3-flash': { id: 'gemini-3-flash', label: '3 Flash', class: 'flash', accounts: ['a1'] },
};

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Starts a real ApiServer on a free loopback port with a fake scheduler. */
async function startApi(t, submit = async () => ({ text: 'hi', model: 'gemini-3.1-pro', label: '3.1 Pro', account: 'a1' })) {
  const store = new Store(':memory:');
  const key = randomToken('hub_');
  const otherKey = randomToken('hub_');
  const narrowKey = randomToken('hub_');
  const mk = (id, k, cidrs, models = '*') =>
    store.insertApp({ id, name: id, key_hash: sha256(k), key_hint: k.slice(-4), cidrs, models, created_at: Date.now() });
  mk('local', key, '127.0.0.0/8');
  mk('remote', otherKey, '10.0.0.0/8');
  mk('narrow', narrowKey, '127.0.0.1', 'gemini-3-flash');
  const submitted = [];
  const scheduler = {
    submitted,
    catalogue: () => CATALOGUE,
    submit: (req) => {
      submitted.push(req);
      return submit(req);
    },
  };
  const port = await freePort();
  let listening;
  const ready = new Promise((r) => (listening = r));
  const api = new ApiServer({
    config: { apiListen: [`127.0.0.1:${port}`], allowCidrs: ['127.0.0.0/8'] },
    store,
    scheduler,
    log: (kind) => kind === 'api_listening' && listening(),
  });
  await api.start();
  await ready;
  t.after(() => api.stop());
  const base = `http://127.0.0.1:${port}`;
  const call = (path, { method = 'GET', body, headers = {}, key: k = key, raw } = {}) =>
    fetch(base + path, {
      method,
      headers: { ...(k ? { authorization: `Bearer ${k}` } : {}), 'content-type': 'application/json', connection: 'close', ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  return { call, store, scheduler, submitted, key, otherKey, narrowKey, base };
}

const chatBody = (extra = {}) => ({ model: 'gemini-3.1-pro', messages: [{ role: 'user', content: 'hello' }], ...extra });
const geminiBody = (extra = {}) => ({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }], ...extra });

function sseEvents(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((b) => b.replace(/^data: /, ''));
}

test('/healthz answers without a key', async (t) => {
  const a = await startApi(t);
  const res = await a.call('/healthz', { key: null });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('missing or wrong key -> 401, same message; source binding enforced', async (t) => {
  const a = await startApi(t);
  const none = await a.call('/v1/models', { key: null });
  assert.equal(none.status, 401);
  const noneBody = await none.json();
  assert.equal(noneBody.error.code, 'unauthenticated');

  const wrong = await a.call('/v1/models', { key: 'definitely-wrong' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), noneBody);

  // valid key, but bound to 10.0.0.0/8 while the request comes from 127.0.0.1
  const bound = await a.call('/v1/models', { key: a.otherKey });
  assert.equal(bound.status, 401);
  assert.deepEqual(await bound.json(), noneBody);
  const ev = a.store.events().find((e) => e.kind === 'auth_failed' && e.detail.reason === 'source_not_bound');
  assert.ok(ev);
  assert.equal(ev.detail.app, 'remote');

  // gemini flavour of the same failure
  const g = await a.call('/v1beta/models', { key: null });
  assert.equal(g.status, 401);
  const gb = await g.json();
  assert.equal(gb.error.code, 401);
  assert.equal(gb.error.status, 'UNAUTHENTICATED');
});

test('key is accepted from x-goog-api-key, x-api-key and ?key=', async (t) => {
  const a = await startApi(t);
  for (const res of [
    await a.call('/v1beta/models', { key: null, headers: { 'x-goog-api-key': a.key } }),
    await a.call('/v1/models', { key: null, headers: { 'x-api-key': a.key } }),
    await a.call(`/v1/models?key=${a.key}`, { key: null }),
  ]) {
    assert.equal(res.status, 200);
    await res.text();
  }
});

test('repeated failures block the source address', async (t) => {
  const a = await startApi(t);
  for (let i = 0; i < 10; i++) await (await a.call('/v1/models', { key: 'bad' })).text();
  const res = await a.call('/v1/models');
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '1800');
  assert.equal((await res.json()).error.code, 'blocked');
});

test('OpenAI non-stream: response shape, headers, request handed to the scheduler', async (t) => {
  const a = await startApi(t, async () => ({ text: 'Hello there', model: 'gemini-3.1-pro', label: '3.1 Pro', account: 'a7', deduplicated: true }));
  const res = await a.call('/v1/chat/completions', { method: 'POST', body: chatBody() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-hub-model'), 'gemini-3.1-pro');
  assert.equal(res.headers.get('x-hub-model-label'), '3.1 Pro');
  assert.equal(res.headers.get('x-hub-account'), 'a7');
  assert.equal(res.headers.get('x-hub-deduplicated'), '1');
  const body = await res.json();
  assert.match(body.id, /^chatcmpl-[0-9a-f]{24}$/);
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.model, 'gemini-3.1-pro');
  assert.deepEqual(body.choices, [{ index: 0, message: { role: 'assistant', content: 'Hello there' }, finish_reason: 'stop' }]);
  assert.equal(body.usage.prompt_tokens, 2);
  assert.equal(body.usage.completion_tokens, 3);
  assert.equal(body.usage.total_tokens, 5);
  const req = a.submitted[0];
  assert.equal(req.app.id, 'local');
  assert.equal(req.model, 'gemini-3.1-pro');
  assert.equal(req.prompt.text, 'hello');
  assert.equal(req.json, null);
  assert.equal(req.onProgress, null);
  assert.match(req.dedupeKey, /^[0-9a-f]{64}$/);
});

test('OpenAI JSON mode instruction reaches the scheduler', async (t) => {
  const a = await startApi(t);
  await (await a.call('/v1/chat/completions', { method: 'POST', body: chatBody({ response_format: { type: 'json_object' }, stream: true }) })).text();
  assert.deepEqual(a.submitted[0].json, { schema: null });
  assert.match(a.submitted[0].prompt.text, /only one valid JSON value/);
  assert.equal(a.submitted[0].onProgress, null, 'no live stream in JSON mode');
});

test('dedupe key follows Idempotency-Key, otherwise the body', async (t) => {
  const a = await startApi(t);
  const post = (headers, body = chatBody()) => a.call('/v1/chat/completions', { method: 'POST', body, headers }).then((r) => r.text());
  await post({ 'idempotency-key': 'one' });
  await post({ 'idempotency-key': 'one' }, chatBody({ messages: [{ role: 'user', content: 'different' }] }));
  await post({});
  await post({});
  const [k1, k2, k3, k4] = a.submitted.map((r) => r.dedupeKey);
  assert.equal(k1, k2);
  assert.equal(k3, k4);
  assert.notEqual(k1, k3);
});

test('OpenAI stream: SSE ends with [DONE] and deltas add up to the final text', async (t) => {
  const final = 'Hello world, this is the final markdown!';
  const a = await startApi(t, async (req) => {
    req.onProgress('Hel');
    req.onProgress('Hello wor');
    req.onProgress('Hello world, this');
    req.onProgress('Hello world, this'); // no growth: ignored
    req.onProgress('totally different'); // not a prefix extension: ignored
    return { text: final, model: 'gemini-3.1-pro', label: '3.1 Pro', account: 'a1' };
  });
  const res = await a.call('/v1/chat/completions', { method: 'POST', body: chatBody({ stream: true, stream_options: { include_usage: true } }) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const events = sseEvents(await res.text());
  assert.equal(events.at(-1), '[DONE]');
  const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  const text = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('');
  assert.equal(text, final);
  const finish = chunks.filter((c) => c.choices[0]?.finish_reason === 'stop');
  assert.equal(finish.length, 1);
  assert.ok(chunks.at(-1).usage.total_tokens > 0, 'include_usage chunk');
  assert.ok(chunks.length > 4);
});

test('OpenAI stream without live progress still sends everything and the hub headers', async (t) => {
  const a = await startApi(t, async () => ({ text: 'whole answer', model: 'gemini-3.1-pro', label: '3.1 Pro', account: 'a3' }));
  const res = await a.call('/v1/chat/completions', { method: 'POST', body: chatBody({ stream: true }) });
  assert.equal(res.headers.get('x-hub-account'), 'a3');
  const events = sseEvents(await res.text());
  assert.equal(events.at(-1), '[DONE]');
  const text = events.slice(0, -1).map((e) => JSON.parse(e).choices[0]?.delta?.content ?? '').join('');
  assert.equal(text, 'whole answer');
});

test('Gemini generateContent: response shape', async (t) => {
  const a = await startApi(t, async () => ({ text: 'Merhaba', model: 'gemini-3.1-pro', label: '3.1 Pro', account: 'a1' }));
  const res = await a.call('/v1beta/models/gemini-3.1-pro:generateContent', { method: 'POST', body: geminiBody() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-hub-model'), 'gemini-3.1-pro');
  const body = await res.json();
  assert.deepEqual(body.candidates[0].content, { role: 'model', parts: [{ text: 'Merhaba' }] });
  assert.equal(body.candidates[0].finishReason, 'STOP');
  assert.equal(body.modelVersion, 'gemini-3.1-pro');
  assert.equal(body.usageMetadata.totalTokenCount, body.usageMetadata.promptTokenCount + body.usageMetadata.candidatesTokenCount);
  assert.equal(a.submitted[0].model, 'gemini-3.1-pro');
  assert.equal(a.submitted[0].prompt.text, 'hello');
});

test('Gemini generateContent: JSON mode from generationConfig', async (t) => {
  const a = await startApi(t);
  await (await a.call('/v1beta/models/gemini-3.1-pro:generateContent', { method: 'POST', body: geminiBody({ generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT' } } }) })).text();
  assert.deepEqual(a.submitted[0].json, { schema: { type: 'OBJECT' } });
});

test('Gemini streamGenerateContent?alt=sse: pieces add up to the final text', async (t) => {
  const final = 'Streaming answer in full.';
  const a = await startApi(t, async (req) => {
    req.onProgress('Stream');
    req.onProgress('Streaming ans');
    return { text: final, model: 'gemini-3.1-pro', label: '3.1 Pro', account: 'a1' };
  });
  const res = await a.call('/v1beta/models/gemini-3.1-pro:streamGenerateContent?alt=sse', { method: 'POST', body: geminiBody() });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const events = sseEvents(await res.text()).map((e) => JSON.parse(e));
  const text = events.map((e) => e.candidates[0].content.parts[0].text).join('');
  assert.equal(text, final);
  assert.equal(events.at(-1).candidates[0].finishReason, 'STOP');
  assert.ok(events.at(-1).usageMetadata.totalTokenCount > 0);
  assert.ok(events.slice(0, -1).every((e) => e.candidates[0].finishReason === undefined));
});

test('Gemini streamGenerateContent without alt=sse returns a JSON array', async (t) => {
  const a = await startApi(t, async () => ({ text: 'x', model: 'gemini-3.1-pro', label: '3.1 Pro', account: 'a1' }));
  const res = await a.call('/v1beta/models/gemini-3.1-pro:streamGenerateContent', { method: 'POST', body: geminiBody() });
  const body = await res.json();
  assert.equal(Array.isArray(body), true);
  assert.equal(body[0].candidates[0].content.parts[0].text, 'x');
  assert.equal(a.submitted[0].onProgress, null);
});

test('HubError maps to status, Retry-After and the right error shape', async (t) => {
  const a = await startApi(t, async () => {
    throw new HubError(429, 'capacity', 'all accounts are at their safe limit', { retryAfter: 120 });
  });
  const o = await a.call('/v1/chat/completions', { method: 'POST', body: chatBody() });
  assert.equal(o.status, 429);
  assert.equal(o.headers.get('retry-after'), '120');
  assert.deepEqual(await o.json(), { error: { message: 'all accounts are at their safe limit', type: 'rate_limit_error', code: 'capacity' } });

  const g = await a.call('/v1beta/models/gemini-3.1-pro:generateContent', { method: 'POST', body: geminiBody() });
  assert.equal(g.status, 429);
  assert.equal(g.headers.get('retry-after'), '120');
  assert.deepEqual(await g.json(), {
    error: { code: 429, message: 'all accounts are at their safe limit', status: 'RESOURCE_EXHAUSTED', details: [{ reason: 'capacity' }] },
  });
});

test('HubError without retryAfter: 404, 403 and 5xx shapes', async (t) => {
  let err;
  const a = await startApi(t, async () => {
    throw err;
  });
  err = new HubError(404, 'model_not_found', 'no such model');
  let res = await a.call('/v1/chat/completions', { method: 'POST', body: chatBody() });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('retry-after'), null);
  assert.equal((await res.json()).error.type, 'invalid_request_error');

  err = new HubError(503, 'no_account', 'nobody home', { retryAfter: 600 });
  res = await a.call('/v1/chat/completions', { method: 'POST', body: chatBody() });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '600');
  assert.equal((await res.json()).error.type, 'server_error');

  err = new HubError(502, 'model_changed', 'discarded');
  res = await a.call('/v1beta/models/gemini-3.1-pro:generateContent', { method: 'POST', body: geminiBody() });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.status, 'UNAVAILABLE');
});

test('HubError after streaming started ends the SSE stream with an error event', async (t) => {
  const a = await startApi(t, async (req) => {
    req.onProgress('partial');
    throw new HubError(429, 'account_limit', 'limit while answering');
  });
  const res = await a.call('/v1/chat/completions', { method: 'POST', body: chatBody({ stream: true }) });
  assert.equal(res.status, 200);
  const events = sseEvents(await res.text());
  assert.equal(events.at(-1), '[DONE]');
  assert.equal(JSON.parse(events.at(-2)).error.code, 'account_limit');
});

test('/v1/models and /v1beta/models are filtered by the app allowlist', async (t) => {
  const a = await startApi(t);
  const all = await (await a.call('/v1/models')).json();
  assert.equal(all.object, 'list');
  assert.deepEqual(all.data.map((m) => m.id).sort(), ['gemini-3-flash', 'gemini-3.1-pro']);
  assert.equal(all.data[0].object, 'model');

  const narrow = await (await a.call('/v1/models', { key: a.narrowKey })).json();
  assert.deepEqual(narrow.data.map((m) => m.id), ['gemini-3-flash']);

  const g = await (await a.call('/v1beta/models', { key: a.narrowKey })).json();
  assert.deepEqual(g.models, [
    { name: 'models/gemini-3-flash', displayName: '3 Flash', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
  ]);
});

test('400 on non-JSON bodies and invalid requests', async (t) => {
  const a = await startApi(t);
  let res = await a.call('/v1/chat/completions', { method: 'POST', raw: 'not json{' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.type, 'invalid_request_error');
  assert.equal(body.error.code, 'invalid_request');
  assert.match(body.error.message, /not JSON/);

  res = await a.call('/v1beta/models/gemini-3.1-pro:generateContent', { method: 'POST', raw: '<xml/>' });
  assert.equal(res.status, 400);
  const gb = await res.json();
  assert.equal(gb.error.code, 400);
  assert.equal(gb.error.status, 'INVALID_ARGUMENT');

  res = await a.call('/v1/chat/completions', { method: 'POST', body: { messages: [{ role: 'user', content: 'x' }] } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /model is required/);

  res = await a.call('/v1/chat/completions', { method: 'POST', body: chatBody({ n: 2 }) });
  assert.equal(res.status, 400);

  res = await a.call('/v1/chat/completions', { method: 'POST', body: chatBody({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] }] }) });
  assert.equal(res.status, 400);

  res = await a.call('/v1/chat/completions', { method: 'POST', body: chatBody({ messages: [{ role: 'assistant', content: 'last is not user' }] }) });
  assert.equal(res.status, 400);
  assert.equal(a.submitted.length, 0, 'nothing reached the scheduler');
});

test('unknown endpoint -> 404', async (t) => {
  const a = await startApi(t);
  const res = await a.call('/v1/nothing');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'not_found');
});
