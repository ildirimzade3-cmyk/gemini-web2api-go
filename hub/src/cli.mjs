// Operator CLI, run inside the container:
//   docker exec gemini-hub node src/cli.mjs admin-token <file>     new admin token, written to <file> (0600)
//   docker exec gemini-hub node src/cli.mjs app-add <name> <cidrs> [models] [daily_cap] <keyfile>
//   docker exec gemini-hub node src/cli.mjs status
// Secrets are written to files, never printed.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { loadConfig } from './config.mjs';
import { Store } from './db.mjs';
import { parseCidr, randomToken, sha256 } from './security.mjs';

const [cmd, ...args] = process.argv.slice(2);
const store = new Store(loadConfig().dbPath);

function writeSecret(file, value) {
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

if (cmd === 'admin-token') {
  const token = randomToken('gha_');
  store.set('admin_token_hash', sha256(token));
  store.event('warn', 'admin_token_rotated', null, {});
  writeSecret(args[0], token);
  console.log(`admin token written to ${args[0]} (restart not needed; old token invalid)`);
} else if (cmd === 'app-add') {
  const [name, cidrs, models = '*', cap = '', keyfile] = args.length === 3 ? [args[0], args[1], '*', '', args[2]] : args;
  cidrs.split(',').forEach(parseCidr);
  const key = randomToken('ghk_');
  store.insertApp({
    id: `app_${crypto.randomBytes(4).toString('hex')}`,
    name,
    key_hash: sha256(key),
    key_hint: `${key.slice(0, 8)}…${key.slice(-4)}`,
    cidrs,
    models,
    daily_cap: cap ? Number(cap) : null,
    created_at: Date.now(),
  });
  writeSecret(keyfile, key);
  console.log(`app ${name} created; key written to ${keyfile}`);
} else if (cmd === 'status') {
  for (const a of store.accounts()) console.log(a.id, a.label, a.state, a.plan, a.identity, a.models.map((m) => m.id).join(','));
  for (const a of store.apps()) console.log(a.id, a.name, a.key_hint, a.cidrs, a.models, a.revoked_at ? 'revoked' : 'active');
} else {
  console.log('commands: admin-token <file> | app-add <name> <cidrs> [models] [daily_cap] <keyfile> | status');
  process.exit(2);
}
