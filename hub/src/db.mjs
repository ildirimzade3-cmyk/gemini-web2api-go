// SQLite store (node:sqlite). Holds accounts, app keys (hashed), the usage ledger
// (metadata only: never prompt or answer text), learned limits, events and small
// key/value facts. Profiles (the actual Google sessions) live on disk, not here.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL,              -- new | ready | paused | attention
  state_reason TEXT NOT NULL DEFAULT '',
  state_since INTEGER NOT NULL,
  plan TEXT NOT NULL DEFAULT 'unknown',   -- unknown | free | paid
  plan_label TEXT NOT NULL DEFAULT '',
  identity TEXT NOT NULL DEFAULT '',      -- masked e-mail as shown by the page
  models TEXT NOT NULL DEFAULT '[]',      -- catalogue read from the model picker
  models_at INTEGER NOT NULL DEFAULT 0,
  sleep_start_min INTEGER NOT NULL,       -- UTC minute of day the daily rest starts
  sleep_len_min INTEGER NOT NULL,
  last_open_at INTEGER NOT NULL DEFAULT 0,
  last_job_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL UNIQUE,
  key_hint TEXT NOT NULL,
  cidrs TEXT NOT NULL,                    -- comma list; the key only works from these
  models TEXT NOT NULL DEFAULT '*',       -- comma list of model ids or *
  daily_cap INTEGER,                      -- requests per rolling 24 h, NULL = no cap
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  app_id TEXT NOT NULL,
  account_id TEXT,
  model TEXT NOT NULL,
  status TEXT NOT NULL,                   -- ok | error | rejected
  sent INTEGER NOT NULL DEFAULT 0,        -- 1 when a prompt reached Google
  prompts INTEGER NOT NULL DEFAULT 0,     -- prompts sent to Google for this request
  queue_ms INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  in_chars INTEGER NOT NULL DEFAULT 0,
  out_chars INTEGER NOT NULL DEFAULT 0,
  code TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS usage_acct ON usage(account_id, model, ts);
CREATE INDEX IF NOT EXISTS usage_app ON usage(app_id, ts);
CREATE TABLE IF NOT EXISTS limits (
  account_id TEXT NOT NULL,
  model TEXT NOT NULL,
  observed_limit INTEGER,                 -- prompts in 24 h when Google said "limit"
  observed_at INTEGER,
  exhausted_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, model)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,                    -- info | warn | alert
  kind TEXT NOT NULL,
  account_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    if (file !== ':memory:') fs.chmodSync(file, 0o600);
  }

  q(sql) {
    return this.db.prepare(sql);
  }

  // --- kv
  get(k, fallback = null) {
    const row = this.q('SELECT v FROM kv WHERE k = ?').get(k);
    return row ? JSON.parse(row.v) : fallback;
  }
  set(k, v) {
    this.q('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));
  }

  // --- accounts
  accounts() {
    return this.q('SELECT * FROM accounts ORDER BY created_at').all().map(rowToAccount);
  }
  account(id) {
    const r = this.q('SELECT * FROM accounts WHERE id = ?').get(id);
    return r ? rowToAccount(r) : null;
  }
  insertAccount(a) {
    this.q(
      `INSERT INTO accounts (id, label, created_at, state, state_reason, state_since, sleep_start_min, sleep_len_min)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(a.id, a.label, a.created_at, a.state, a.state_reason ?? '', a.state_since, a.sleep_start_min, a.sleep_len_min);
  }
  updateAccount(id, fields) {
    const cols = Object.keys(fields);
    if (!cols.length) return;
    const vals = cols.map((c) => (c === 'models' ? JSON.stringify(fields[c]) : fields[c]));
    this.q(`UPDATE accounts SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...vals, id);
  }
  deleteAccount(id) {
    this.q('DELETE FROM accounts WHERE id = ?').run(id);
    this.q('DELETE FROM limits WHERE account_id = ?').run(id);
  }

  // --- apps
  apps() {
    return this.q('SELECT * FROM apps ORDER BY created_at').all();
  }
  appByHash(hash) {
    return this.q('SELECT * FROM apps WHERE key_hash = ? AND revoked_at IS NULL').get(hash) ?? null;
  }
  insertApp(a) {
    this.q(
      'INSERT INTO apps (id, name, key_hash, key_hint, cidrs, models, daily_cap, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(a.id, a.name, a.key_hash, a.key_hint, a.cidrs, a.models, a.daily_cap ?? null, a.created_at);
  }
  updateApp(id, fields) {
    const cols = Object.keys(fields);
    if (!cols.length) return;
    this.q(`UPDATE apps SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => fields[c]), id);
  }

  // --- usage
  recordUsage(u) {
    this.q(
      `INSERT INTO usage (ts, app_id, account_id, model, status, sent, prompts, queue_ms, ms, in_chars, out_chars, code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(u.ts, u.app_id, u.account_id ?? null, u.model, u.status, u.sent ? 1 : 0, u.prompts ?? 0, u.queue_ms ?? 0, u.ms ?? 0, u.in_chars ?? 0, u.out_chars ?? 0, u.code ?? '');
  }
  /** Prompts this account sent to Google for `model` since `since` (all models when model is null). */
  promptsSince(accountId, model, since) {
    const row = model
      ? this.q('SELECT COALESCE(SUM(prompts), 0) AS n FROM usage WHERE account_id = ? AND model = ? AND ts >= ?').get(accountId, model, since)
      : this.q('SELECT COALESCE(SUM(prompts), 0) AS n FROM usage WHERE account_id = ? AND ts >= ?').get(accountId, since);
    return Number(row.n);
  }
  appRequestsSince(appId, since) {
    return Number(this.q("SELECT COUNT(*) AS n FROM usage WHERE app_id = ? AND ts >= ? AND status != 'rejected'").get(appId, since).n);
  }
  usageSummary(since) {
    return this.q(
      `SELECT model, status, code, COUNT(*) AS n, SUM(prompts) AS prompts, AVG(ms) AS avg_ms, AVG(queue_ms) AS avg_queue_ms
       FROM usage WHERE ts >= ? GROUP BY model, status, code ORDER BY model`,
    ).all(since);
  }
  pruneUsage(before) {
    this.q('DELETE FROM usage WHERE ts < ?').run(before);
    this.q('DELETE FROM events WHERE ts < ?').run(before);
  }

  // --- limits
  limit(accountId, model) {
    return this.q('SELECT * FROM limits WHERE account_id = ? AND model = ?').get(accountId, model) ?? null;
  }
  limitsFor(accountId) {
    return this.q('SELECT * FROM limits WHERE account_id = ?').all(accountId);
  }
  setLimit(accountId, model, fields) {
    this.q('INSERT INTO limits (account_id, model) VALUES (?, ?) ON CONFLICT DO NOTHING').run(accountId, model);
    const cols = Object.keys(fields);
    this.q(`UPDATE limits SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE account_id = ? AND model = ?`).run(
      ...cols.map((c) => fields[c]),
      accountId,
      model,
    );
  }

  // --- events
  event(level, kind, accountId = null, detail = {}) {
    this.q('INSERT INTO events (ts, level, kind, account_id, detail) VALUES (?, ?, ?, ?, ?)').run(
      Date.now(),
      level,
      kind,
      accountId,
      JSON.stringify(detail),
    );
  }
  events(limit = 200) {
    return this.q('SELECT * FROM events ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((e) => ({ ...e, detail: JSON.parse(e.detail) }));
  }
}

function rowToAccount(r) {
  return { ...r, models: JSON.parse(r.models || '[]') };
}
