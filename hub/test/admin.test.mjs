import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminServer } from '../src/admin.mjs';

const make = (adminListen) => new AdminServer({ config: { adminListen }, store: {}, scheduler: {}, log: () => {} });

test('admin listens only on loopback or tailnet addresses', () => {
  assert.throws(() => make(['152.53.39.199:18091']), /neither loopback nor tailnet/);
  assert.throws(() => make(['0.0.0.0:18091']), /neither loopback nor tailnet/);
  assert.throws(() => make(['172.17.0.1:18091']), /neither loopback nor tailnet/);
  const a = make(['127.0.0.1:18091', '100.102.156.33:18091']);
  assert.deepEqual([...a.hosts].sort(), ['100.102.156.33:18091', '127.0.0.1:18091', 'localhost:18091']);
});
