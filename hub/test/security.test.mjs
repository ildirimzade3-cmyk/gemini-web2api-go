import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.mjs';
import { AuthThrottle, authenticate, extractKey, ipInCidrs, normalizeIp, parseCidr, randomToken, sha256 } from '../src/security.mjs';

test('parseCidr accepts IPv4/IPv6 and rejects bad input', () => {
  assert.equal(parseCidr('10.0.0.0/8').v, 4);
  assert.equal(parseCidr('fd7a:115c::/32').v, 6);
  assert.equal(parseCidr('1.2.3.4').mask, 0xffffffff);
  for (const bad of ['', 'nope', '1.2.3.4/33', '1.2.3.4/-1', '1.2.3.4/x', '::1/129', '999.1.1.1/8']) {
    assert.throws(() => parseCidr(bad), /bad CIDR/, bad);
  }
});

test('ipInCidrs: IPv4, mapped IPv4, IPv6, /0', () => {
  assert.equal(ipInCidrs('10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(ipInCidrs('11.1.2.3', ['10.0.0.0/8']), false);
  assert.equal(ipInCidrs('100.64.0.1', ['100.64.0.0/10']), true);
  assert.equal(ipInCidrs('100.128.0.1', ['100.64.0.0/10']), false);
  assert.equal(ipInCidrs('::ffff:10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(normalizeIp('::1'), '::1');
  assert.equal(ipInCidrs('fd7a:115c::1', ['fd7a:115c::/32']), true);
  assert.equal(ipInCidrs('fd7a:115d::1', ['fd7a:115c::/32']), false);
  assert.equal(ipInCidrs('::1', ['::1/128']), true);
  assert.equal(ipInCidrs('::2', ['::1/128']), false);
  assert.equal(ipInCidrs('8.8.8.8', ['0.0.0.0/0']), true);
  assert.equal(ipInCidrs('2001:db8::1', ['::/0']), true);
  assert.equal(ipInCidrs('10.0.0.1', ['fd00::/8']), false);
  assert.equal(ipInCidrs('fd00::1', ['10.0.0.0/8']), false);
  assert.equal(ipInCidrs('10.0.0.1', []), false);
  assert.equal(ipInCidrs('10.0.0.1', [parseCidr('10.0.0.0/24')]), true);
  assert.throws(() => ipInCidrs('10.0.0.1', ['garbage']), /bad CIDR/);
});

test('randomToken shape and uniqueness', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const t = randomToken('hub_');
    assert.match(t, /^hub_[0-9A-Za-z]{43,44}$/);
    seen.add(t);
  }
  assert.equal(seen.size, 200);
});

test('extractKey reads every supported place', () => {
  const u = (s = '') => new URL(`http://hub/x${s}`);
  assert.equal(extractKey({ headers: { authorization: 'Bearer abc' } }, u()), 'abc');
  assert.equal(extractKey({ headers: { authorization: 'bearer   abc ' } }, u()), 'abc');
  assert.equal(extractKey({ headers: { 'x-goog-api-key': ' g1 ' } }, u()), 'g1');
  assert.equal(extractKey({ headers: { 'x-api-key': 'x1' } }, u()), 'x1');
  assert.equal(extractKey({ headers: {} }, u('?key=q1')), 'q1');
  assert.equal(extractKey({ headers: {} }, u()), '');
  assert.equal(extractKey({ headers: { authorization: 'Bearer b', 'x-api-key': 'x' } }, u('?key=q')), 'b');
});

test('AuthThrottle blocks after 10 failures and resets on ok', () => {
  const t = new AuthThrottle();
  const now = 1_000_000;
  for (let i = 0; i < 9; i++) assert.equal(t.fail('1.1.1.1', now + i), false);
  assert.equal(t.blocked('1.1.1.1', now + 10), false);
  assert.equal(t.fail('1.1.1.1', now + 10), true);
  assert.equal(t.blocked('1.1.1.1', now + 11), true);
  assert.equal(t.blocked('2.2.2.2', now + 11), false);
  assert.equal(t.blocked('1.1.1.1', now + 31 * 60_000), false);
  t.ok('1.1.1.1');
  assert.equal(t.blocked('1.1.1.1', now + 11), false);

  const u = new AuthThrottle();
  for (let i = 0; i < 5; i++) u.fail('3.3.3.3', now);
  u.ok('3.3.3.3');
  for (let i = 0; i < 9; i++) u.fail('3.3.3.3', now);
  assert.equal(u.blocked('3.3.3.3', now), false);
});

function setup() {
  const store = new Store(':memory:');
  const key = randomToken('hub_');
  store.insertApp({ id: 'app1', name: 'one', key_hash: sha256(key), key_hint: key.slice(-4), cidrs: '10.0.0.0/8, 100.64.0.0/10', models: '*', created_at: 1 });
  const req = (k) => ({ headers: { authorization: `Bearer ${k}` } });
  return { store, key, req };
}
const url = new URL('http://hub/v1/models');

test('authenticate: valid key from bound CIDR passes', () => {
  const { store, key, req } = setup();
  assert.equal(authenticate(store, req(key), url, '10.2.3.4').app.id, 'app1');
  assert.equal(authenticate(store, req(key), url, '100.64.1.1').app.id, 'app1');
});

test('authenticate: failures share one public message', () => {
  const { store, key, req } = setup();
  const wrongIp = authenticate(store, req(key), url, '192.168.0.1');
  const unknown = authenticate(store, req('nope'), url, '10.2.3.4');
  const none = authenticate(store, { headers: {} }, url, '10.2.3.4');
  assert.equal(wrongIp.app, undefined);
  assert.equal(wrongIp.status, 401);
  assert.equal(wrongIp.reason, 'source_not_bound');
  assert.equal(unknown.reason, 'unknown_key');
  assert.equal(none.reason, 'no_key');
  assert.equal(wrongIp.error, unknown.error);
  assert.equal(wrongIp.error, none.error);
  assert.equal(authenticate(store, req('x'.repeat(201)), url, '10.2.3.4').reason, 'no_key');
});

test('authenticate: revoked key fails', () => {
  const { store, key, req } = setup();
  store.updateApp('app1', { revoked_at: Date.now() });
  const r = authenticate(store, req(key), url, '10.2.3.4');
  assert.equal(r.app, undefined);
  assert.equal(r.status, 401);
  assert.equal(r.reason, 'unknown_key');
});
