import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { HubError, Scheduler } from '../src/scheduler.mjs';
import { UiError, ATTACHED_PROMPT_INSTRUCTION } from '../src/ui.mjs';

const MODEL_ID = 'gemini-3.1-pro';
const LABEL = '3.1 Pro';
const settle = () => new Promise((r) => setTimeout(r, 25));

/** Scripted stand-in for GeminiPage. Every hook can be overridden per test. */
class FakePage {
  constructor(id, hooks = {}) {
    this.id = id;
    this.hooks = hooks;
    this.shown = LABEL;
    this.inserts = [];
    this.sends = 0;
    this.attached = [];
    this.followUps = [];
    this.answers = [`answer from ${id}`];
  }
  async newChat() {
    await this.hooks.newChat?.(this);
  }
  async temporaryChat() {
    return true;
  }
  async selectModel(label) {
    await this.hooks.selectModel?.(this, label);
  }
  async currentModel() {
    if (this.hooks.currentModel) return this.hooks.currentModel(this);
    return this.shown;
  }
  async readUsage() {
    this.usageReads = (this.usageReads ?? 0) + 1;
    return { meters: this.hooks.meters ?? [{ name: '5h', used_pct: 10, resets_at: Date.now() + 3_600_000 }], raw: '' };
  }
  async verifyModel(label) {
    const shown = await this.currentModel();
    return { ok: shown === label || label.endsWith(shown), shown };
  }
  async attach(files) {
    this.attached.push(files);
  }
  async insert(text) {
    this.inserts.push(text);
    await this.hooks.insert?.(this, text);
  }
  async send() {
    this.sends += 1;
    await this.hooks.send?.(this);
  }
  async waitAnswer(onProgress) {
    if (this.hooks.waitAnswer) return this.hooks.waitAnswer(this, onProgress);
    onProgress?.('par');
    return { text: this.answers.shift() ?? 'answer', via: 'copy' };
  }
  async followUp(text, onProgress) {
    this.followUps.push(text);
    if (this.hooks.followUp) return this.hooks.followUp(this, text, onProgress);
    return { text: this.answers.shift() ?? 'answer', via: 'copy' };
  }
  async diagnostic() {
    return null;
  }
}

class FakeRuntime {
  constructor(account, page, dir) {
    this.id = account.id;
    this.page = page;
    this.profile = path.join(dir, 'profiles', account.id);
    this.busy = false;
    this.warm = false;
    this.restUntil = 0;
    this.lastUsed = 0;
    this.signin = null;
    this.gpage = null;
    this.closed = [];
    this.opens = 0;
  }
  async open() {
    this.opens += 1;
    this.warm = true;
    this.gpage = this.page;
    return this.page;
  }
  async close(reason) {
    this.closed.push(reason);
    this.warm = false;
  }
  async shutdown() {
    this.warm = false;
  }
  async inspect() {
    return { signed_in: true, identity: 'x', plan: 'free', plan_label: '', models: [] };
  }
  async startSignIn() {}
  async stopSignIn() {}
}

function harness(t, { accounts = 1, plan = 'paid', hooks = {}, configOverride = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sched-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { ...loadConfig({ HUB_DATA: dir }), maxWarmBrowsers: 5, ...configOverride };
  const store = new Store(':memory:');
  const now = Date.now();
  const pages = {};
  for (let i = 1; i <= accounts; i++) {
    const id = `a${i}`;
    store.insertAccount({ id, label: `Account ${i}`, created_at: now - 1000 + i, state: 'ready', state_since: now });
    store.updateAccount(id, { plan, models: [{ id: MODEL_ID, label: LABEL, enabled: true }], usage: { meters: [{ name: '5h', used_pct: 10, resets_at: now + 3_600_000 }], read_at: now } });
    pages[id] = new FakePage(id, hooks[id] ?? {});
  }
  store.insertApp({ id: 'app1', name: 'one', key_hash: 'h1', key_hint: 'h1', cidrs: '*', models: '*', daily_cap: null, created_at: now });
  const alerts = { calls: [], notify(x) { this.calls.push(x); return Promise.resolve(false); } };
  const runtimes = {};
  const scheduler = new Scheduler({
    config,
    store,
    alerts,
    log: () => {},
    makeRuntime: (account) => (runtimes[account.id] = new FakeRuntime(account, pages[account.id], dir)),
  });
  scheduler.start();
  t.after(() => scheduler.stop());
  const app = () => store.apps()[0];
  const req = (extra = {}) => ({ app: app(), model: MODEL_ID, prompt: { text: 'hello', files: [] }, json: null, ...extra });
  return { scheduler, store, alerts, pages, runtimes, req, config, app };
}

const rejectsWith = (p, status, code) =>
  assert.rejects(p, (e) => {
    assert.ok(e instanceof HubError, `expected HubError, got ${e}`);
    assert.equal(e.status, status);
    assert.equal(e.code, code);
    return true;
  });

const usageRows = (store) => store.q('SELECT * FROM usage ORDER BY id').all();

test('happy path: text, model, account, usage with prompts=1, rest after answer', async (t) => {
  const h = harness(t);
  const progress = [];
  const r = await h.scheduler.submit(h.req({ onProgress: (x) => progress.push(x) }));
  assert.equal(r.text, 'answer from a1');
  assert.equal(r.model, MODEL_ID);
  assert.equal(r.label, LABEL);
  assert.equal(r.account, 'a1');
  assert.equal(r.prompts, 1);
  assert.equal(r.temporary, true);
  assert.deepEqual(progress, ['par']);
  assert.deepEqual(h.pages.a1.inserts, ['hello']);
  assert.equal(h.pages.a1.sends, 1);
  const rows = usageRows(h.store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].prompts, 1);
  assert.equal(rows[0].sent, 1);
  assert.equal(rows[0].account_id, 'a1');
  assert.equal(rows[0].model, MODEL_ID);
  assert.equal(rows[0].out_chars, 'answer from a1'.length);
  await settle();
  assert.equal(h.runtimes.a1.busy, false);
  assert.ok(h.runtimes.a1.restUntil - Date.now() >= 1500, 'account rests after an answer');
  assert.equal(h.store.account('a1').last_job_at > 0, true);
});

test('prompts above the attach threshold go in as message.txt', async (t) => {
  const h = harness(t);
  const big = 'x'.repeat(31 * 1024);
  await h.scheduler.submit(h.req({ prompt: { text: big, files: [] } }));
  assert.deepEqual(h.pages.a1.inserts, [ATTACHED_PROMPT_INSTRUCTION]);
  assert.equal(h.pages.a1.attached[0][0].name, 'message.txt');
  assert.equal(h.pages.a1.attached[0][0].data.length, big.length);
});

test('unknown model -> 404 model_not_found, recorded as rejected', async (t) => {
  const h = harness(t);
  await rejectsWith(h.scheduler.submit(h.req({ model: 'gemini-9-ultra' })), 404, 'model_not_found');
  const rows = usageRows(h.store);
  assert.equal(rows[0].status, 'rejected');
  assert.equal(rows[0].code, 'model_not_found');
  assert.equal(h.pages.a1.sends, 0);
});

test('app model allowlist -> 403 model_not_allowed', async (t) => {
  const h = harness(t);
  h.store.updateApp('app1', { models: 'gemini-3-flash' });
  await rejectsWith(h.scheduler.submit(h.req()), 403, 'model_not_allowed');
  h.store.updateApp('app1', { models: `gemini-3-flash, ${MODEL_ID}` });
  const r = await h.scheduler.submit(h.req());
  assert.equal(r.account, 'a1');
});

test('app daily_cap -> 429 app_cap with retryAfter', async (t) => {
  const h = harness(t);
  h.store.updateApp('app1', { daily_cap: 1 });
  await h.scheduler.submit(h.req());
  await settle();
  await assert.rejects(h.scheduler.submit(h.req()), (e) => {
    assert.equal(e.status, 429);
    assert.equal(e.code, 'app_cap');
    assert.equal(e.retryAfter, 3600);
    return true;
  });
  assert.equal(h.pages.a1.sends, 1);
});

test('limit error BEFORE send moves the job to the second account', async (t) => {
  const resetAt = Date.now() + 3 * 3_600_000;
  const h = harness(t, {
    accounts: 2,
    hooks: { a1: { selectModel: () => { throw new UiError('limit', 'limit reached', { sent: false, resetAt }); } } },
  });
  const r = await h.scheduler.submit(h.req());
  assert.equal(r.account, 'a2');
  assert.equal(r.text, 'answer from a2');
  assert.equal(h.pages.a1.sends, 0);
  assert.equal(h.pages.a1.inserts.length, 0);
  assert.equal(h.pages.a2.sends, 1);
  const lim = h.store.limit('a1', MODEL_ID);
  assert.equal(lim.exhausted_until, resetAt);
  assert.equal(lim.observed_limit, 0);
  assert.ok(h.alerts.calls.some((c) => c.key === `limit:a1:${MODEL_ID}` && c.accountId === 'a1'));
  await settle();
  const rows = usageRows(h.store);
  assert.deepEqual(rows.map((x) => [x.account_id, x.status, x.code, x.prompts]), [['a1', 'error', 'limit', 0], ['a2', 'ok', '', 1]]);
});

test('Google HTTP 429 before send: the account cools down by itself (not "needs you") and another serves', async (t) => {
  const h = harness(t, {
    accounts: 2,
    hooks: { a1: { newChat: () => { throw new UiError('throttled', 'gemini.google.com answered HTTP 429', { sent: false }); } } },
  });
  const r = await h.scheduler.submit(h.req());
  assert.equal(r.account, 'a2');
  const a1 = h.store.account('a1');
  assert.equal(a1.state, 'ready');
  assert.ok(a1.cooldown_until - Date.now() > 14 * 60_000 && a1.cooldown_until - Date.now() <= 15 * 60_000);
  assert.ok(h.alerts.calls.some((c) => c.key === 'throttled:a1'));
  assert.ok(h.scheduler.accountStatus(a1, { id: MODEL_ID, label: '3.1 Pro' }).blockers.includes('cooldown'));
});

test('limit error AFTER send -> 429 account_limit and the prompt is never resent', async (t) => {
  const h = harness(t, {
    accounts: 2,
    hooks: { a1: { waitAnswer: () => { throw new UiError('limit', 'You reached your limit', { sent: true }); } } },
  });
  await rejectsWith(h.scheduler.submit(h.req()), 429, 'account_limit');
  await settle();
  const inserts = h.pages.a1.inserts.length + h.pages.a2.inserts.length;
  const sends = h.pages.a1.sends + h.pages.a2.sends;
  assert.equal(inserts, 1);
  assert.equal(sends, 1);
  assert.equal(h.pages.a2.sends, 0);
  const lim = h.store.limit('a1', MODEL_ID);
  assert.ok(lim.exhausted_until > Date.now());
  assert.equal(lim.observed_limit, 1);
  const rows = usageRows(h.store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sent, 1);
  assert.equal(rows[0].prompts, 1);
  assert.equal(rows[0].code, 'limit');
});

test('challenge -> account goes to attention, alert sent, job moves on', async (t) => {
  const h = harness(t, {
    accounts: 2,
    hooks: { a1: { newChat: () => { throw new UiError('challenge', 'unusual traffic', { sent: false }); } } },
  });
  const r = await h.scheduler.submit(h.req());
  assert.equal(r.account, 'a2');
  const a1 = h.store.account('a1');
  assert.equal(a1.state, 'attention');
  assert.match(a1.state_reason, /unusual traffic/);
  assert.deepEqual(h.runtimes.a1.closed, ['attention']);
  const alert = h.alerts.calls.find((c) => c.key === 'attention:a1');
  assert.ok(alert);
  assert.equal(alert.priority, 'high');
  assert.equal(h.store.events().some((e) => e.kind === 'account_attention' && e.level === 'alert'), true);
  // an account in attention takes no more work (skip a2's normal rest after its answer)
  await settle();
  h.runtimes.a2.restUntil = 0;
  const r2 = await h.scheduler.submit(h.req());
  assert.equal(r2.account, 'a2');
});

test('challenge after send -> 503 account_stopped, no resend', async (t) => {
  const h = harness(t, {
    accounts: 2,
    hooks: { a1: { waitAnswer: () => { throw new UiError('challenge', 'captcha', { sent: true }); } } },
  });
  await rejectsWith(h.scheduler.submit(h.req()), 503, 'account_stopped');
  assert.equal(h.pages.a1.sends + h.pages.a2.sends, 1);
  assert.equal(h.store.account('a1').state, 'attention');
});

test('model_changed after send -> 502 and the answer is discarded', async (t) => {
  let n = 0;
  const h = harness(t, {
    accounts: 2,
    hooks: { a1: { currentModel: (p) => (++n >= 2 ? 'Flash' : p.shown) } },
  });
  await assert.rejects(h.scheduler.submit(h.req()), (e) => {
    assert.equal(e.status, 502);
    assert.equal(e.code, 'model_changed');
    assert.equal(e.text, undefined);
    return true;
  });
  await settle();
  assert.equal(h.pages.a1.sends, 1);
  assert.equal(h.pages.a2.sends, 0);
  assert.ok(h.store.limit('a1', MODEL_ID).exhausted_until > Date.now());
  const rows = usageRows(h.store);
  assert.equal(rows[0].status, 'error');
  assert.equal(rows[0].code, 'model_changed');
  assert.equal(rows[0].sent, 1);
});

test('picker showing another model BEFORE send -> nothing sent on that account', async (t) => {
  const h = harness(t, { accounts: 2, hooks: { a1: { currentModel: () => 'Flash' } } });
  const r = await h.scheduler.submit(h.req());
  assert.equal(r.account, 'a2');
  assert.equal(h.pages.a1.sends, 0);
  assert.equal(h.pages.a1.inserts.length, 1);
  await settle();
  const a1row = usageRows(h.store).find((x) => x.account_id === 'a1');
  assert.equal(a1row.sent, 0);
  assert.equal(a1row.prompts, 0);
  assert.equal(a1row.code, 'model_changed');
});

test('picker showing another model before send, single account -> fails, nothing sent', async (t) => {
  const h = harness(t, { hooks: { a1: { currentModel: () => 'Flash' } } });
  await assert.rejects(h.scheduler.submit(h.req()), (e) => e instanceof HubError && e.status === 429);
  assert.equal(h.pages.a1.sends, 0);
});

test('JSON mode: invalid reply repaired through followUp -> prompts=2', async (t) => {
  const h = harness(t);
  h.pages.a1.answers = ['sorry, here you go: nothing', '{"a":1}'];
  const r = await h.scheduler.submit(h.req({ json: { schema: { type: 'object', required: ['a'] } } }));
  assert.equal(r.text, '{"a":1}');
  assert.equal(r.prompts, 2);
  assert.equal(h.pages.a1.followUps.length, 1);
  assert.match(h.pages.a1.followUps[0], /not valid JSON/);
  assert.equal(h.pages.a1.sends, 1);
  const rows = usageRows(h.store);
  assert.equal(rows[0].prompts, 2);
  assert.equal(rows[0].status, 'ok');
});

test('JSON mode: valid first time needs one prompt; invalid twice -> 502 json_invalid', async (t) => {
  const h = harness(t);
  h.pages.a1.answers = ['```json\n{"a":1}\n```'];
  const ok = await h.scheduler.submit(h.req({ json: { schema: null } }));
  assert.equal(ok.text, '{"a":1}');
  assert.equal(ok.prompts, 1);

  const h2 = harness(t);
  h2.pages.a1.answers = ['nope', 'still nope'];
  await assert.rejects(h2.scheduler.submit(h2.req({ json: { schema: null } })), (e) => {
    assert.equal(e.status, 502);
    assert.equal(e.code, 'json_invalid');
    assert.equal(e.text, 'still nope');
    return true;
  });
  assert.equal(usageRows(h2.store)[0].prompts, 2);
});

test('every account at the 95 % meter line -> 429 capacity at once, with reasons and the reset time', async (t) => {
  const h = harness(t, { accounts: 2 });
  const reset = Date.now() + 2 * 3_600_000;
  for (const id of ['a1', 'a2']) h.store.updateAccount(id, { usage: { meters: [{ name: '5h', used_pct: 97, resets_at: reset }], read_at: Date.now() } });
  await assert.rejects(h.scheduler.submit(h.req()), (e) => {
    assert.equal(e.status, 429);
    assert.equal(e.code, 'capacity');
    assert.match(e.message, /usage_5h/);
    assert.ok(Math.abs(e.retryAfter - 7200) <= 2, String(e.retryAfter));
    return true;
  });
  assert.ok(h.alerts.calls.some((c) => c.key === `capacity:${MODEL_ID}`));
  assert.equal(h.pages.a1.sends + h.pages.a2.sends, 0);
  const cap = h.scheduler.capacity().find((c) => c.model === MODEL_ID);
  assert.equal(cap.accounts_available, 0);
  assert.equal(cap.next_free_at, reset);
  assert.equal(cap.rejected_24h, 1);
});

test('a stale meter is read before the account is used; a full one moves the job on, nothing sent', async (t) => {
  const reset = Date.now() + 3_600_000;
  const h = harness(t, { accounts: 2, hooks: { a1: { meters: [{ name: '5h', used_pct: 99, resets_at: reset }] } } });
  h.store.updateAccount('a1', { usage: { meters: [{ name: '5h', used_pct: 50, resets_at: reset }], read_at: Date.now() - 3_600_000 } });
  h.store.updateAccount('a2', { usage: { meters: [{ name: '5h', used_pct: 60, resets_at: reset }], read_at: Date.now() } });
  const r = await h.scheduler.submit(h.req());
  assert.equal(r.account, 'a2');
  assert.equal(h.pages.a1.usageReads, 1);
  assert.equal(h.pages.a1.sends, 0);
  assert.equal(h.store.account('a1').usage.meters[0].used_pct, 99);
});

test('accounts that are not ready are never used; none ready -> 503 no_account', async (t) => {
  const h = harness(t, { accounts: 2 });
  h.scheduler.setState('a1', 'paused', 'operator');
  const r = await h.scheduler.submit(h.req());
  assert.equal(r.account, 'a2');
  h.scheduler.setState('a2', 'paused', 'operator');
  await rejectsWith(h.scheduler.submit(h.req()), 503, 'no_account');
});

test('dedupe: identical submits with one dedupeKey run the page once', async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = harness(t, {
    hooks: { a1: { waitAnswer: async (p) => { await gate; return { text: 'once', via: 'copy' }; } } },
  });
  const p1 = h.scheduler.submit(h.req({ dedupeKey: 'k1' }));
  const p2 = h.scheduler.submit(h.req({ dedupeKey: 'k1' }));
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.text, 'once');
  assert.equal(r1.deduplicated, undefined);
  assert.equal(r2.text, 'once');
  assert.equal(r2.deduplicated, true);
  assert.equal(h.pages.a1.sends, 1);
  assert.equal(h.pages.a1.inserts.length, 1);
  // still inside the dedupe window after completion
  const r3 = await h.scheduler.submit(h.req({ dedupeKey: 'k1' }));
  assert.equal(r3.deduplicated, true);
  assert.equal(h.pages.a1.sends, 1);
  assert.equal(usageRows(h.store).length, 1);
});

test('dedupe: a failure with nothing sent is not remembered', async (t) => {
  const h = harness(t);
  await rejectsWith(h.scheduler.submit(h.req({ dedupeKey: 'k2', model: 'nope' })), 404, 'model_not_found');
  await settle();
  const r = await h.scheduler.submit(h.req({ dedupeKey: 'k2' }));
  assert.equal(r.deduplicated, undefined);
  assert.equal(h.pages.a1.sends, 1);
});

test('a prompt that reached Google is not repeated for a deduplicated retry', async (t) => {
  const h = harness(t, {
    accounts: 2,
    hooks: { a1: { waitAnswer: () => { throw new UiError('generation_failed', 'Something went wrong', { sent: true }); } } },
  });
  await rejectsWith(h.scheduler.submit(h.req({ dedupeKey: 'k3' })), 502, 'generation_failed');
  await settle();
  await rejectsWith(h.scheduler.submit(h.req({ dedupeKey: 'k3' })), 502, 'generation_failed');
  assert.equal(h.pages.a1.sends + h.pages.a2.sends, 1);
});

test('stop() rejects queued jobs and shuts runtimes down', async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = harness(t, {
    hooks: { a1: { waitAnswer: async () => { await gate; return { text: 't', via: 'copy' }; } } },
  });
  const running = h.scheduler.submit(h.req());
  const queued = h.scheduler.submit(h.req({ prompt: { text: 'second', files: [] } }));
  await settle();
  const stopping = h.scheduler.stop();
  await rejectsWith(queued, 503, 'shutting_down');
  release();
  await stopping;
  assert.equal((await running).text, 't');
  assert.equal(h.pages.a1.inserts.length, 1);
});
