// The hub's brain: which account answers which request, and when.
//
// Rules (account safety first):
// - one prompt at a time per account, a human-like rest after every answer, an
//   hourly cap, a daily budget per model and a daily rest window;
// - any limit, check or sign-out Google shows stops that account (or that model on
//   it) at once; checks and sign-outs wait for the operator;
// - a prompt that reached Google is never sent again (no retry after `sent`); a
//   request may move to another account only while nothing was sent;
// - the requested model is used or the request fails: never a silent substitute.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AccountRuntime } from './account.mjs';
import { SelectorBook, UiError, ATTACH_THRESHOLD_BYTES, ATTACHED_PROMPT_INSTRUCTION } from './ui.mjs';
import { budgetFor, hourlyCap, modelClass, modelId, restAfterMs, restState, UNKNOWN_RESET_MS, defaultSleep } from './policy.mjs';
import { judgeJson } from './prompt.mjs';

const DAY = 86_400_000;
const HOUR = 3_600_000;

export class HubError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    Object.assign(this, { status, code }, extra);
  }
}

export class Scheduler {
  /** makeRuntime(account, deps) is replaceable for tests; defaults to a real AccountRuntime. */
  constructor({ config, store, alerts, log, makeRuntime = (account, deps) => new AccountRuntime(account, deps) }) {
    Object.assign(this, { config, store, alerts, log, makeRuntime });
    this.book = new SelectorBook(store.get('selectors', {}), (learned) => {
      store.set('selectors', learned);
      store.event('warn', 'selector_learned', null, { roles: Object.keys(learned) });
    });
    this.runtimes = new Map();
    this.queue = [];
    this.inflight = new Map(); // dedupe key -> { promise, done, result, at }
    this.served = new Map(); // app id -> start times of its recent jobs (fair share)
    this.timer = null;
    this.stopped = false;
  }

  start() {
    this.store.accounts().forEach((a, i) => this.#runtime(a, i));
    this.timer = setInterval(() => this.#tick().catch((e) => this.log('tick_error', { error: e.message })), 1000);
    this.housekeeping = setInterval(() => this.#housekeeping().catch((e) => this.log('housekeeping_error', { error: e.message })), 30_000);
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.housekeeping);
    for (const job of this.queue) job.reject(new HubError(503, 'shutting_down', 'the hub is restarting; nothing was sent'));
    this.queue = [];
    await Promise.all([...this.runtimes.values()].map((r) => r.shutdown()));
  }

  #runtime(account, index = null) {
    let rt = this.runtimes.get(account.id);
    if (!rt) {
      const i = index ?? Number(account.id.replace(/\D/g, '')) - 1;
      rt = this.makeRuntime(account, { config: this.config, store: this.store, book: this.book, index: i, log: this.log });
      this.runtimes.set(account.id, rt);
    }
    return rt;
  }

  // --- accounts --------------------------------------------------------------

  addAccount(label) {
    const ids = this.store.accounts().map((a) => Number(a.id.slice(1)));
    const n = (ids.length ? Math.max(...ids) : 0) + 1;
    const now = Date.now();
    const account = { id: `a${n}`, label: label || `Hesap ${n}`, created_at: now, state: 'new', state_since: now, ...defaultSleep(n - 1) };
    this.store.insertAccount(account);
    this.store.event('info', 'account_added', account.id, { label: account.label });
    this.#runtime(this.store.account(account.id), n - 1);
    return this.store.account(account.id);
  }

  setState(id, state, reason = '') {
    this.store.updateAccount(id, { state, state_reason: reason.slice(0, 300), state_since: Date.now() });
    this.store.event(state === 'attention' ? 'alert' : 'info', `account_${state}`, id, { reason });
  }

  async startSignIn(id) {
    const rt = this.runtimes.get(id);
    if (!rt) throw new HubError(404, 'not_found', 'no such account');
    return rt.startSignIn();
  }

  /** Ends the sign-in view and checks the account: signed in -> ready with its catalogue. */
  async finishSignIn(id) {
    const rt = this.runtimes.get(id);
    if (!rt) throw new HubError(404, 'not_found', 'no such account');
    await rt.stopSignIn();
    return this.refreshAccount(id);
  }

  async refreshAccount(id) {
    const rt = this.runtimes.get(id);
    if (rt.busy) throw new HubError(409, 'busy', 'the account is answering a prompt');
    rt.busy = true;
    try {
      const info = await rt.inspect();
      const fields = { identity: info.identity, plan: info.plan, plan_label: info.plan_label };
      if (info.signed_in) {
        fields.models = info.models.map((m) => ({ id: modelId(m.label), label: m.label, description: m.description, enabled: m.enabled }));
        fields.models_at = Date.now();
      }
      this.store.updateAccount(id, fields);
      const acct = this.store.account(id);
      if (info.signed_in && acct.state !== 'paused') this.setState(id, 'ready', `${info.identity} (${info.plan})`);
      if (!info.signed_in) this.setState(id, acct.state === 'new' ? 'new' : 'attention', 'not signed in');
      return this.store.account(id);
    } finally {
      rt.busy = false;
      rt.lastUsed = Date.now();
    }
  }

  async removeAccount(id) {
    const rt = this.runtimes.get(id);
    if (rt) {
      await rt.shutdown();
      this.runtimes.delete(id);
      fs.rmSync(rt.profile, { recursive: true, force: true });
    }
    this.store.deleteAccount(id);
    this.store.event('warn', 'account_removed', id, {});
  }

  // --- catalogue and capacity ------------------------------------------------

  /** { modelId: { id, label, class, accounts: [accountId] } } over usable accounts. */
  catalogue({ includeAll = false } = {}) {
    const out = {};
    for (const a of this.store.accounts()) {
      if (!includeAll && a.state !== 'ready') continue;
      for (const m of a.models) {
        if (!m.id) continue;
        const e = (out[m.id] ??= { id: m.id, label: m.label, class: modelClass(m.label), accounts: [] });
        e.accounts.push(a.id);
      }
    }
    return out;
  }

  /** Remaining safe prompts and the reasons an account cannot take `model` now. */
  accountStatus(account, model, now = Date.now()) {
    const lim = this.store.limit(account.id, model.id);
    const { budget, source } = budgetFor(account, model, lim);
    const used = this.store.promptsSince(account.id, model.id, now - DAY);
    const hourUsed = this.store.promptsSince(account.id, null, now - HOUR);
    const rest = restState(account, now);
    const rt = this.runtimes.get(account.id);
    const blockers = [];
    if (account.state !== 'ready') blockers.push(account.state);
    if (rest.resting) blockers.push('resting');
    if (lim?.exhausted_until > now) blockers.push('limit');
    if (used >= budget) blockers.push('budget');
    if (hourUsed >= hourlyCap(account)) blockers.push('hourly');
    if (rt?.signin) blockers.push('signin');
    const entry = account.models.find((m) => m.id === model.id);
    if (!entry) blockers.push('no_model');
    else if (entry.enabled === false) blockers.push('model_disabled');
    return {
      budget,
      budget_source: source,
      used,
      remaining: Math.max(0, budget - used),
      hour_used: hourUsed,
      exhausted_until: lim?.exhausted_until > now ? lim.exhausted_until : 0,
      observed_limit: lim?.observed_limit ?? null,
      resting_until: rest.until,
      blockers,
    };
  }

  /** Per model: what the accounts can safely carry today and what was asked of them. */
  capacity(now = Date.now()) {
    const cat = this.catalogue({ includeAll: true });
    const accounts = this.store.accounts();
    const demand = this.store.q(
      `SELECT model, COUNT(*) AS n, SUM(CASE WHEN code IN ('capacity','queue_full','app_cap') THEN 1 ELSE 0 END) AS rejected
       FROM usage WHERE ts >= ? GROUP BY model`,
    ).all(now - DAY);
    const byModel = Object.fromEntries(demand.map((d) => [d.model, d]));
    return Object.values(cat).map((m) => {
      const per = accounts
        .filter((a) => m.accounts.includes(a.id))
        .map((a) => ({ account: a.id, label: a.label, state: a.state, ...this.accountStatus(a, m, now) }));
      const healthy = per.filter((p) => !p.blockers.some((b) => ['new', 'paused', 'attention', 'no_model', 'model_disabled'].includes(b)));
      const safePerDay = healthy.reduce((n, p) => n + p.budget, 0);
      const d = byModel[m.id] ?? { n: 0, rejected: 0 };
      return {
        model: m.id,
        label: m.label,
        class: m.class,
        safe_per_day: safePerDay,
        remaining_now: healthy.reduce((n, p) => n + (p.blockers.length ? 0 : p.remaining), 0),
        requests_24h: Number(d.n),
        rejected_24h: Number(d.rejected),
        overloaded: Number(d.rejected) > 0 || Number(d.n) > safePerDay * 0.9,
        accounts: per,
      };
    });
  }

  // --- requests --------------------------------------------------------------

  /**
   * Runs one request. req: { app, model, prompt: { text, files }, json, stream,
   * onProgress, dedupeKey, inChars }. Resolves { text, model, label, account,
   * deduplicated, ... } or rejects with HubError.
   */
  submit(req) {
    if (req.dedupeKey) {
      const hit = this.inflight.get(req.dedupeKey);
      if (hit && (!hit.done || Date.now() - hit.at < this.config.dedupeWindowMs)) {
        return hit.promise.then((r) => ({ ...r, deduplicated: true }));
      }
    }
    const promise = this.#admit(req);
    if (req.dedupeKey) {
      const entry = { promise, done: false, at: Date.now() };
      this.inflight.set(req.dedupeKey, entry);
      promise.then(
        () => Object.assign(entry, { done: true, at: Date.now() }),
        (e) => (e.sent ? Object.assign(entry, { done: true, at: Date.now() }) : this.inflight.delete(req.dedupeKey)),
      );
    }
    return promise;
  }

  #admit(req) {
    const now = Date.now();
    const cat = this.catalogue({ includeAll: true });
    const model = cat[req.model];
    const reject = (status, code, message, extra) => {
      this.store.recordUsage({ ts: now, app_id: req.app.id, model: req.model, status: 'rejected', code });
      return Promise.reject(new HubError(status, code, message, extra));
    };
    if (!model) {
      const known = Object.keys(cat).join(', ') || 'none yet (no account is signed in)';
      return reject(404, 'model_not_found', `model "${req.model}" is not offered by any account. Available: ${known}`);
    }
    const allowed = req.app.models === '*' ? null : req.app.models.split(',').map((s) => s.trim());
    if (allowed && !allowed.includes(model.id)) return reject(403, 'model_not_allowed', `this app may not use ${model.id}`);
    if (req.app.daily_cap != null && this.store.appRequestsSince(req.app.id, now - DAY) >= req.app.daily_cap) {
      return reject(429, 'app_cap', `this app used its ${req.app.daily_cap} requests for the last 24 h`, { retryAfter: 3600 });
    }
    if (this.queue.filter((j) => j.app.id === req.app.id).length >= 50) {
      return reject(429, 'queue_full', 'this app already has 50 requests waiting', { retryAfter: 60 });
    }
    const verdict = this.#couldServe(model, now);
    if (!verdict.ok) {
      if (verdict.code === 'capacity') {
        this.alerts.notify({
          key: `capacity:${model.id}`,
          title: `${model.label}: load above safe capacity`,
          message: `Requests for ${model.label} are being refused to protect the accounts (${verdict.message}). Add an account or lower the load.`,
        });
      }
      return reject(verdict.status, verdict.code, verdict.message, { retryAfter: verdict.retryAfter });
    }
    return new Promise((resolve, reject2) => {
      this.queue.push({ ...req, model, id: crypto.randomUUID(), queuedAt: now, tried: new Set(), resolve, reject: reject2 });
      this.#tick().catch(() => {});
    });
  }

  /** Whether any account can take `model` now or later today (not ever -> refuse at once). */
  #couldServe(model, now) {
    const accounts = this.store.accounts().filter((a) => model.accounts.includes(a.id));
    const statuses = accounts.map((a) => ({ a, s: this.accountStatus(a, model, now) }));
    const usable = statuses.filter(({ s }) => !s.blockers.some((b) => ['new', 'paused', 'attention', 'no_model', 'model_disabled'].includes(b)));
    if (!usable.length) {
      return { ok: false, status: 503, code: 'no_account', message: `no healthy account offers ${model.label} right now (signed out, paused or waiting for the operator)`, retryAfter: 600 };
    }
    const soon = usable.filter(({ s }) => !s.blockers.some((b) => ['limit', 'budget'].includes(b)));
    if (!soon.length) {
      const until = Math.min(...usable.map(({ s, a }) => s.exhausted_until || this.#budgetFreesAt(a, model, now)));
      return {
        ok: false,
        status: 429,
        code: 'capacity',
        message: `every account reached the safe daily amount for ${model.label}; next free slot ${new Date(until).toISOString()}`,
        retryAfter: Math.max(60, Math.ceil((until - now) / 1000)),
      };
    }
    return { ok: true };
  }

  #budgetFreesAt(account, model, now) {
    const row = this.store
      .q('SELECT ts FROM usage WHERE account_id = ? AND model = ? AND prompts > 0 AND ts >= ? ORDER BY ts LIMIT 1')
      .get(account.id, model.id, now - DAY);
    return row ? row.ts + DAY : now + HOUR;
  }

  async #tick() {
    if (this.stopped || !this.queue.length) return;
    const now = Date.now();
    // Fair share across apps: the app that started the fewest jobs in the last
    // 10 minutes goes first, then round robin, so one app cannot starve the others.
    const recent = (appId) => (this.served.get(appId) ?? []).filter((t) => now - t < 600_000).length;
    const byApp = new Map();
    for (const j of this.queue) (byApp.get(j.app.id) ?? byApp.set(j.app.id, []).get(j.app.id)).push(j);
    const lists = [...byApp.entries()].sort((x, y) => recent(x[0]) - recent(y[0])).map(([, l]) => l);
    const order = [];
    for (let i = 0; order.length < this.queue.length; i++) for (const list of lists) if (list[i]) order.push(list[i]);
    for (const job of order) {
      const account = this.#pick(job, now);
      if (!account) {
        const verdict = this.#couldServe(job.model, now);
        if (!verdict.ok) {
          this.#dequeue(job);
          job.reject(new HubError(verdict.status, verdict.code, verdict.message, { retryAfter: verdict.retryAfter }));
        }
        continue;
      }
      this.#dequeue(job);
      this.served.set(job.app.id, [...(this.served.get(job.app.id) ?? []).filter((t) => now - t < 600_000), now]);
      this.#run(job, account).catch((e) => this.log('run_error', { error: e.message }));
    }
  }

  #dequeue(job) {
    const i = this.queue.indexOf(job);
    if (i >= 0) this.queue.splice(i, 1);
  }

  /** Best free account for the job: warm first, then most remaining budget, then least recently used. */
  #pick(job, now) {
    const candidates = [];
    for (const a of this.store.accounts()) {
      if (job.tried.has(a.id) || !job.model.accounts.includes(a.id)) continue;
      const rt = this.runtimes.get(a.id);
      if (!rt || rt.busy || rt.restUntil > now) continue;
      const s = this.accountStatus(a, job.model, now);
      if (s.blockers.length) continue;
      candidates.push({ a, rt, s });
    }
    if (!candidates.length) return null;
    const warmCount = [...this.runtimes.values()].filter((r) => r.warm).length;
    candidates.sort(
      (x, y) =>
        Number(y.rt.warm) - Number(x.rt.warm) || y.s.remaining / y.s.budget - x.s.remaining / x.s.budget || x.rt.lastUsed - y.rt.lastUsed,
    );
    const best = candidates[0];
    if (!best.rt.warm && warmCount >= this.config.maxWarmBrowsers) {
      // Make room: close the idle warm browser used longest ago; wait when all are busy.
      const idle = [...this.runtimes.values()].filter((r) => r.warm && !r.busy).sort((x, y) => x.lastUsed - y.lastUsed)[0];
      if (!idle) return null;
      idle.close('make-room').catch(() => {});
    }
    return best.a;
  }

  async #run(job, account) {
    const rt = this.runtimes.get(account.id);
    rt.busy = true;
    const started = Date.now();
    let sent = false;
    let prompts = 0;
    let outChars = 0;
    const usage = (status, code = '') =>
      this.store.recordUsage({
        ts: Date.now(),
        app_id: job.app.id,
        account_id: account.id,
        model: job.model.id,
        status,
        sent,
        prompts,
        queue_ms: started - job.queuedAt,
        ms: Date.now() - started,
        in_chars: job.inChars ?? job.prompt.text.length,
        out_chars: outChars,
        code,
      });
    const steps = {};
    let mark = Date.now();
    const step = (name) => {
      const t = Date.now();
      steps[name] = t - mark;
      mark = t;
    };
    try {
      const g = await rt.open();
      step('open');
      g.onDrift = (role, message) => this.#drift(role, message);
      await g.newChat();
      if (this.config.chaos && rt.chaos) await g.applyChaos(rt.chaos);
      step('new_chat');
      const temporary = await g.temporaryChat();
      step('temporary');
      await g.selectModel(job.model.label);
      step('model');
      let text = job.prompt.text;
      const files = [...job.prompt.files];
      if (Buffer.byteLength(text) > ATTACH_THRESHOLD_BYTES) {
        files.push({ name: 'message.txt', mime: 'text/plain', data: Buffer.from(text, 'utf8') });
        text = ATTACHED_PROMPT_INSTRUCTION;
      }
      if (files.length) await g.attach(files);
      step('attach');
      await g.insert(text);
      step('insert');
      // Last look before the irreversible step: the picker must still show the model.
      const before = await g.verifyModel(job.model.label);
      if (!before.ok) throw new UiError('model_changed', `picker shows "${before.shown}" instead of "${job.model.label}"`);
      try {
        prompts = 1;
        sent = true;
        await g.send();
        step('send');
      } catch (e) {
        if (e instanceof UiError && !e.sent && e.code === 'ui_changed' && e.role === 'send') {
          sent = false;
          prompts = 0;
        }
        throw e;
      }
      let answer = await g.waitAnswer((t) => job.onProgress?.(t));
      step('answer');
      const after = await g.verifyModel(job.model.label);
      if (!after.ok) throw new UiError('model_changed', `the answer came with "${after.shown}" instead of "${job.model.label}"`, { sent: true });
      let json = null;
      if (job.json) {
        json = judgeJson(answer.text, job.json.schema);
        if (!json.valid) {
          prompts = 2;
          answer = await g.followUp(
            `That reply is not valid JSON for the requested format (${json.errors.slice(0, 3).join('; ')}). Reply again with only the corrected JSON value, nothing else.`,
          );
          json = judgeJson(answer.text, job.json.schema);
        }
      }
      step('verify_json');
      outChars = answer.text.length;
      this.log('job_done', { account: account.id, model: job.model.id, temporary, via: answer.via, prompts, steps });
      if (json && !json.valid) {
        usage('error', 'json_invalid');
        throw new HubError(502, 'json_invalid', `the model did not return valid JSON (${json.errors.slice(0, 3).join('; ')})`, { sent: true, text: answer.text });
      }
      usage('ok');
      this.store.updateAccount(account.id, { last_job_at: Date.now() });
      job.resolve({
        text: json ? json.text : answer.text,
        model: job.model.id,
        label: job.model.label,
        account: account.id,
        temporary,
        via: answer.via,
        prompts,
        ms: Date.now() - started,
        queue_ms: started - job.queuedAt,
      });
    } catch (e) {
      if (e instanceof HubError) return job.reject(e);
      const err = e instanceof UiError ? e : new UiError('browser_error', e.message.split('\n')[0]);
      if (err.sent) sent = true;
      if (!sent) prompts = 0;
      await this.#onFailure(job, account, rt, err, sent);
      usage('error', err.code);
    } finally {
      rt.busy = false;
      rt.lastUsed = Date.now();
      rt.restUntil = Date.now() + (prompts ? restAfterMs(outChars) : 2000);
      this.#tick().catch(() => {});
    }
  }

  async #onFailure(job, account, rt, err, sent) {
    const now = Date.now();
    const id = account.id;
    this.log('job_failed', { account: id, code: err.code, sent, message: err.message });
    const requeue = () => {
      job.tried.add(id);
      this.queue.unshift(job);
    };
    const fail = (status, code, message) => job.reject(new HubError(status, code, message, { sent }));
    switch (err.code) {
      case 'limit': {
        const used = this.store.promptsSince(id, job.model.id, now - DAY) + (sent ? 1 : 0);
        const until = err.resetAt && err.resetAt > now ? err.resetAt : now + UNKNOWN_RESET_MS;
        this.store.setLimit(id, job.model.id, { observed_limit: used, observed_at: now, exhausted_until: until });
        this.store.event('warn', 'limit_hit', id, { model: job.model.id, after_prompts_24h: used, until, message: err.message });
        this.alerts.notify({
          key: `limit:${id}:${job.model.id}`,
          title: `${account.label}: ${job.model.label} limit`,
          message: `Google showed a limit after ${used} prompts in 24 h. ${job.model.label} rests on this account until ${new Date(until).toISOString()}; its budget is now 60 % of that count.`,
          accountId: id,
        });
        return sent ? fail(429, 'account_limit', 'the account reached a Gemini limit while answering; the prompt is not resent') : requeue();
      }
      case 'challenge':
      case 'signed_out': {
        this.setState(id, 'attention', err.message);
        await rt.close('attention');
        this.alerts.notify({
          key: `attention:${id}`,
          title: `${account.label} needs you`,
          message: `${err.code === 'challenge' ? 'Google asks for a check' : 'The account is signed out'}. The account is stopped. Open the hub admin page and use "Sign in" for ${account.label}.`,
          priority: 'high',
          accountId: id,
        });
        return sent ? fail(503, 'account_stopped', 'the account was stopped by a Google check; the prompt is not resent') : requeue();
      }
      case 'model_unavailable':
        this.refreshAccount(id).catch(() => {});
        return requeue();
      case 'model_changed':
        this.store.setLimit(id, job.model.id, { exhausted_until: now + HOUR });
        this.store.event('warn', 'model_changed', id, { model: job.model.id, message: err.message });
        return sent ? fail(502, 'model_changed', `Gemini did not answer with ${job.model.label}; the answer was discarded`) : requeue();
      case 'ui_changed': {
        const diag = await rt.gpage?.diagnostic();
        if (diag) this.#saveDiag(id, err, diag);
        this.alerts.notify({
          key: `ui:${err.role}`,
          title: 'gemini.google.com changed',
          message: `A step of the web app no longer works (${err.role}: ${err.message}). ${this.config.repairApiKey ? 'Automatic selector repair is on.' : 'Set HUB_REPAIR_API_KEY for automatic repair.'}`,
          priority: 'high',
        });
        await rt.close('ui-changed');
        if (!sent && job.tried.size === 0) return requeue();
        return fail(503, 'upstream_ui_changed', `the Gemini web app changed (${err.role}); ${sent ? 'the prompt may have been sent and is not resent' : 'nothing was sent'}`);
      }
      case 'generation_failed':
        return fail(502, 'generation_failed', err.message);
      default:
        await rt.close('error');
        if (!sent && job.tried.size < 2) return requeue();
        return fail(503, 'browser_error', err.message);
    }
  }

  /** A step still worked through a fallback, but the site changed: tell the operator once a day. */
  #drift(role, message) {
    this.store.event('warn', 'ui_drift', null, { role, message });
    this.alerts.notify({ key: `drift:${role}`, title: 'gemini.google.com changed a little', message: `${message}. Answers still work; the hub keeps watching.`, everyMs: 86_400_000 });
  }

  #saveDiag(accountId, err, diag) {
    try {
      fs.mkdirSync(this.config.diagDir, { recursive: true, mode: 0o700 });
      const file = path.join(this.config.diagDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${accountId}-${err.role}.json`);
      fs.writeFileSync(file, JSON.stringify({ code: err.code, role: err.role, message: err.message, diag }, null, 1), { mode: 0o600 });
    } catch {
      // diagnostics are best effort
    }
  }

  // --- housekeeping ----------------------------------------------------------

  async #housekeeping() {
    const now = Date.now();
    for (const a of this.store.accounts()) {
      const rt = this.runtimes.get(a.id);
      if (!rt || rt.busy || rt.signin) continue;
      const rest = restState(a, now);
      if (rt.warm && (rest.resting || now - rt.lastUsed > this.config.idleCloseMs || a.state !== 'ready')) {
        await rt.close(rest.resting ? 'rest' : 'idle');
        continue;
      }
      // Keep the session fresh the way a person does: open Gemini now and then, no prompt.
      const quietFor = now - Math.max(a.last_open_at, a.last_job_at);
      if (a.state === 'ready' && !rest.resting && !rt.warm && quietFor > 30 * HOUR + (a.id.charCodeAt(1) % 6) * HOUR) {
        rt.busy = true;
        try {
          const facts = await rt.inspect();
          this.store.event('info', 'session_visit', a.id, { signed_in: facts.signed_in });
          if (!facts.signed_in) {
            this.setState(a.id, 'attention', 'signed out (found during a session visit)');
            this.alerts.notify({ key: `attention:${a.id}`, title: `${a.label} needs you`, message: `The account is signed out. Use "Sign in" for ${a.label} on the hub admin page.`, priority: 'high', accountId: a.id });
          }
        } catch (e) {
          this.store.event('warn', 'session_visit_failed', a.id, { error: e.message });
        } finally {
          rt.busy = false;
          rt.lastUsed = Date.now();
          await rt.close('visit-done');
        }
      }
    }
    for (const [k, v] of this.inflight) if (v.done && now - v.at > this.config.dedupeWindowMs) this.inflight.delete(k);
    // Tell the operator before refusals start: demand near the safe daily capacity.
    if (now - (this.lastCapacityCheck ?? 0) > 30 * 60_000) {
      this.lastCapacityCheck = now;
      for (const c of this.capacity(now)) {
        if (c.requests_24h > c.safe_per_day * 0.8 || c.rejected_24h > 0) {
          this.alerts.notify({
            key: `capacity:${c.model}`,
            title: `${c.label}: near the safe limit`,
            message: `${c.requests_24h} requests in 24 h, ${c.rejected_24h} refused; the signed-in accounts can safely carry about ${c.safe_per_day} a day. Add an account or lower the load.`,
          });
        }
      }
    }
    if (now - (this.lastPrune ?? 0) > 6 * HOUR) {
      this.lastPrune = now;
      this.store.pruneUsage(now - 30 * DAY);
    }
  }
}
