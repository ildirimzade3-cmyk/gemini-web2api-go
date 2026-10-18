import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Store } from '../src/db.mjs';
import { ApiServer } from '../src/api.mjs';
import { randomToken, sha256 } from '../src/security.mjs';

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

/** A hub with one private listener and the public ingress, both on loopback. */
async function startHub(t) {
  const store = new Store(':memory:');
  const publicKey = randomToken('ghk_');
  const secret = randomToken('', 24);
  const privateKey = randomToken('ghk_');
  store.insertApp({ id: 'pub', name: 'pub', key_hash: sha256(publicKey), key_hint: 'p', cidrs: '', models: '*', created_at: Date.now(), path_hash: sha256(secret) });
  store.insertApp({ id: 'priv', name: 'priv', key_hash: sha256(privateKey), key_hint: 'q', cidrs: '127.0.0.0/8', models: '*', created_at: Date.now() });
  const scheduler = {
    catalogue: () => ({ 'gemini-3.8-flash': { id: 'gemini-3.8-flash', label: '3.8 Flash', class: 'flash', accounts: ['a1'] } }),
    submit: async () => ({ text: 'hello', model: 'gemini-3.8-flash', label: '3.8 Flash', account: 'a1' }),
  };
  const [privatePort, publicPort] = [await freePort(), await freePort()];
  let ready = 0;
  let done;
  const both = new Promise((r) => (done = r));
  const api = new ApiServer({
    config: { apiListen: [`127.0.0.1:${privatePort}`], publicListen: `127.0.0.1:${publicPort}`, allowCidrs: ['127.0.0.0/8'] },
    store,
    scheduler,
    log: (k) => k === 'api_listening' && ++ready === 2 && done(),
  });
  await api.start();
  await both;
  t.after(() => api.stop());
  const call = (port, path, key, headers = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', connection: 'close', ...headers },
      body: JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] }),
    });
  return { call, privatePort, publicPort, publicKey, privateKey, secret };
}

test('public link: secret path + key works; either one alone does not', async (t) => {
  const h = await startHub(t);
  const ok = await h.call(h.publicPort, `/p/${h.secret}/v1/chat/completions`, h.publicKey, { 'x-forwarded-for': '203.0.113.7' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).choices[0].message.content, 'hello');
  // right key, wrong path
  const wrongPath = await h.call(h.publicPort, `/p/${'x'.repeat(32)}/v1/chat/completions`, h.publicKey);
  assert.equal(wrongPath.status, 401);
  await wrongPath.text();
  // right path, a key of another app
  const wrongKey = await h.call(h.publicPort, `/p/${h.secret}/v1/chat/completions`, h.privateKey);
  assert.equal(wrongKey.status, 401);
  await wrongKey.text();
  // no secret path at all
  const bare = await h.call(h.publicPort, '/v1/chat/completions', h.publicKey);
  assert.equal(bare.status, 404);
  await bare.text();
});

test('a public-only app key does not work on the private listener (no source binding)', async (t) => {
  const h = await startHub(t);
  const res = await h.call(h.privatePort, '/v1/chat/completions', h.publicKey);
  assert.equal(res.status, 401);
  await res.text();
  const priv = await h.call(h.privatePort, '/v1/chat/completions', h.privateKey);
  assert.equal(priv.status, 200);
  await priv.text();
});

test('public link throttles by the forwarded client address, not by Caddy', async (t) => {
  const h = await startHub(t);
  for (let i = 0; i < 10; i++) await (await h.call(h.publicPort, `/p/${h.secret}/v1/chat/completions`, 'bad', { 'x-forwarded-for': '198.51.100.9' })).text();
  const blocked = await h.call(h.publicPort, `/p/${h.secret}/v1/chat/completions`, 'bad', { 'x-forwarded-for': '198.51.100.9' });
  assert.equal(blocked.status, 429);
  await blocked.text();
  const other = await h.call(h.publicPort, `/p/${h.secret}/v1/chat/completions`, h.publicKey, { 'x-forwarded-for': '203.0.113.8' });
  assert.equal(other.status, 200);
  await other.text();
});
