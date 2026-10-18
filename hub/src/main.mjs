// Gemini hub entry point: store, scheduler, API listeners, loopback admin.

import { loadConfig } from './config.mjs';
import { Store } from './db.mjs';
import { Alerts } from './alerts.mjs';
import { Scheduler } from './scheduler.mjs';
import { ApiServer } from './api.mjs';
import { AdminServer } from './admin.mjs';

const config = loadConfig();
// Logs carry metadata only (no prompt or answer text, no keys).
const log = (kind, detail = {}) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), kind, ...detail })}\n`);
const store = new Store(config.dbPath);
const alerts = new Alerts({ store, server: config.ntfyServer, topic: config.ntfyTopic, log });
const scheduler = new Scheduler({ config, store, alerts, log });
const api = new ApiServer({ config, store, scheduler, log });
const admin = new AdminServer({ config, store, scheduler, log });

scheduler.start();
await api.start();
admin.start();
store.event('info', 'hub_started', null, { api: config.apiListen, accounts: store.accounts().length });
log('hub_started', { api: config.apiListen, admin: config.adminListen });

let stopping = false;
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  log('hub_stopping', { sig });
  await Promise.allSettled([api.stop(), admin.stop()]);
  await scheduler.stop();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
