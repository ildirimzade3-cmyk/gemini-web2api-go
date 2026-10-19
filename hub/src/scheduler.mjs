// The hub's brain: which account answers which request, and when.
//
// Rules:
// - one prompt at a time per account and a short human-like rest after every answer;
// - whether an account can work is what Google says: its usage page (5-hour and
//   weekly meters, stop at 95 % until the reset) and the limits, checks, sign-outs
//   and HTTP 429 it shows; checks and sign-outs wait for the operator;
// - when no account can take a request now, the caller hears it at once (with the
//   reasons and when the next account frees up) instead of waiting for hours;
// - a prompt that reached Google is never sent again (no retry after `sent`); a
//   request may move to another account only while nothing was sent;
// - the requested model is used or the request fails: never a silent substitute.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AccountRuntime } from './account.mjs';
import { SelectorBook, UiError, ATTACH_THRESHOLD_BYTES, ATTACHED_PROMPT_INSTRUCTION } from './ui.mjs';
import { cooldownMs, meterState, modelClass, modelId, restAfterMs, UNKNOWN_RESET_MS } from './policy.mjs';
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
    this.housekeeping = setInterval(() => this.#housekeeping().catch((e) => this.log('housekeeping_error', { error: e.message })), 20_000);
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
    const account = { id: `a${n}`, label: label || `Hesap ${n}`, created_at: now, state: 'new', state_since: now };
    this.store.insertAccount(account);
    this.store.event('info', 'account_added', account.id, { label: account.label });
    this.#runtime(this.store.account(account.id), n - 1);
    return this.store.account(account.id);
  }

  setState(id, state, reason = '') {
    this.store.updateAccount(id, { state, state_reason: reason.slice(0, 300), state_since: Date.now() });
    this.store.event(state === 'attention' ? 'alert' : 'info', `account_${state}`, id, { reason });
  }

  /**
   * Opens the sign-in view and watches it: once the profile holds a Google session
   * (seen twice, 4 s apart) and 10 s more have passed for Google's own pages, the
   * view is closed and the account checked, with no button to press.
   */
  async startSignIn(id) {
    const rt = this.runtimes.get(id);
    if (!rt) throw new HubError(404, 'not_found', 'no such account');
    const r = await rt.startSignIn();
    if (!rt.signinWatch) {
      let seen = 0;
      rt.signinWatch = setInterval(() => {
        if (!rt.signin) return this.#stopWatch(rt);
        seen = rt.signInSeen() ? seen + 1 : 0;
        if (seen === 2) {
          this.#stopWatch(rt);
          setTimeout(() => {
            if (!rt.signin) return;
            this.store.event('info', 'signin_detected', id, {});
            this.finishSignIn(id).catch((e) => this.log('signin_finish_error', { account: id, error: e.message }));
          }, 10_000);
        }
      }, 4000);
    }
    return r;
  }

  #stopWatch(rt) {
    clearInterval(rt.signinWatch);
    rt.signinWatch = null;
  }

  /** Ends the sign-in view and checks the account: signed in -> ready with its catalogue. */
  async finishSignIn(id) {
    const rt = this.runtimes.get(id);
    if (!rt) throw new HubError(404, 'not_found', 'no such account');
    this.#stopWatch(rt);
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

  /** Reads Gemini's usage meter for an idle account and stores it. */
  async readUsage(id, { raw = false } = {}) {
    const rt = this.runtimes.get(id);
    if (!rt) throw new HubError(404, 'not_found', 'no such account');
    if (rt.busy) throw new HubError(409, 'busy', 'the account is answering a prompt');
    rt.busy = true;
    try {
      const g = await rt.open();
      const r = await g.readUsage();
      const usage = { meters: r.meters, read_at: Date.now() };
      this.store.updateAccount(id, { usage });
      return raw ? { ...usage, raw: r.raw } : usage;
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
        if (!m.id || m.enabled === false) continue;
        const e = (out[m.id] ??= { id: m.id, label: m.label, class: modelClass(m.label), accounts: [] });
        e.accounts.push(a.id);
      }
    }
    return out;
  }

  /** Why an account cannot take `model` now (empty = it can), and its meter. */
  accountStatus(account, model, now = Date.now()) {
    const lim = this.store.limit(account.id, model.id);
    const rt = this.runtimes.get(account.id);
    const meter = meterState(account, this.config.usageStop ?? {}, now);
    const blockers = [];
    if (account.state !== 'ready') blockers.push(account.state);
    if (account.cooldown_until > now) blockers.push('cooldown');
    if (lim?.exhausted_until > now) blockers.push('limit');
    blockers.push(...meter.blockers);
    if (rt?.signin) blockers.push('signin');
    const entry = account.models.find((m) => m.id === model.id);
    if (!entry) blockers.push('no_model');
    else if (entry.enabled === false) blockers.push('model_disabled');
    const until = Math.max(account.cooldown_until > now ? account.cooldown_until : 0, lim?.exhausted_until > now ? lim.exhausted_until : 0, meter.until);
    return {
      prompts_24h: this.store.promptsSince(account.id, model.id, now - DAY),
      exhausted_until: lim?.exhausted_until > now ? lim.exhausted_until : 0,
      meter: { five_hour: meter.five, weekly: meter.weekly, read_at: meter.read_at, stale: meter.stale },
      available_again_at: until,
      blockers,
    };
  }

  /** What apps may see about the accounts: label, masked identity, plan, models, meters, availability. */
  publicStatus(now = Date.now()) {
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    return this.store.accounts().map((a) => {
      const meter = meterState(a, this.config.usageStop ?? {}, now);
      const reasons = [...(a.state !== 'ready' ? [a.state] : []), ...(a.cooldown_until > now ? ['cooldown'] : []), ...meter.blockers];
      return {
        account: a.id,
        label: a.label,
        identity: a.identity,
        plan: a.plan,
        models: a.models.filter((m) => m.enabled !== false).map((m) => m.id),
        usage: {
          five_hour_pct: meter.five?.used_pct ?? null,
          five_hour_resets_at: iso(meter.five?.resets_at),
          weekly_pct: meter.weekly?.used_pct ?? null,
          weekly_resets_at: iso(meter.weekly?.resets_at),
          read_at: iso(meter.read_at),
        },
        busy: Boolean(this.runtimes.get(a.id)?.busy),
        available: reasons.length === 0,
        unavailable_reasons: reasons,
        available_again_at: iso(Math.max(a.cooldown_until > now ? a.cooldown_until : 0, meter.until)),
      };
    });
  }

  /** Per model: which accounts can take it now, which cannot and until when, and the last 24 h. */
  capacity(now = Date.now()) {
    const cat = this.catalogue({ includeAll: true });
    const accounts = this.store.accounts();
    const demand = this.store.q(
      `SELECT model, COUNT(*) AS n, SUM(CASE WHEN code IN ('capacity','no_account','queue_full','app_cap') THEN 1 ELSE 0 END) AS rejected
       FROM usage WHERE ts >= ? GROUP BY model`,
    ).all(now - DAY);
    const byModel = Object.fromEntries(demand.map((d) => [d.model, d]));
    return Object.values(cat).map((m) => {
      const per = accounts
        .filter((a) => m.accounts.includes(a.id))
        .map((a) => ({ account: a.id, label: a.label, state: a.state, ...this.accountStatus(a, m, now) }));
      const d = byModel[m.id] ?? { n: 0, rejected: 0 };
      const waiting = per.filter((p) => p.blockers.length && p.available_again_at);
      return {
        model: m.id,
        label: m.label,
        class: m.class,
        accounts_total: per.length,
        accounts_available: per.filter((p) => !p.blockers.length).length,
        next_free_at: waiting.length ? Math.min(...waiting.map((p) => p.available_again_at)) : 0,
        requests_24h: Number(d.n),
        rejected_24h: Number(d.rejected),
        overloaded: Number(d.rejected) > 0,
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
    // "gemini-3.8-flash-high": the thinking level as a model-name suffix, for clients that cannot send it.
    const suffix = !cat[req.model] && /^(.+)-(low|medium|high)$/.exec(String(req.model));
    if (suffix && cat[suffix[1]]) req = { ...req, model: suffix[1], thinking: req.thinking ?? suffix[2] };
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
    if (this.queue.length >= this.config.maxQueue) {
      const est = this.estimateWaitMs(model, this.queue.length + 1, now);
      return reject(429, 'queue_full', `the queue is full (${this.queue.length} requests waiting); estimated wait for a new one about ${Math.ceil(est / 1000)} s — try again later`, {
        retryAfter: Math.max(5, Math.ceil(est / 1000)),
      });
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

  /**
   * Whether an account can take `model` now (busy ones count: they free up within
   * minutes). When every account is blocked by Google (meter at the stop line, limit,
   * 429 pause) or waits for the operator, the caller is told at once, with the
   * reasons and the time the next account frees up.
   */
  #couldServe(model, now) {
    const accounts = this.store.accounts().filter((a) => model.accounts.includes(a.id));
    const statuses = accounts.map((a) => ({ a, s: this.accountStatus(a, model, now) }));
    if (statuses.some(({ s }) => !s.blockers.length)) return { ok: true };
    const why = statuses
      .map(({ a, s }) => {
        const m = s.meter.five_hour ? ` 5h ${s.meter.five_hour.used_pct}%, weekly ${s.meter.weekly?.used_pct ?? '?'}%` : '';
        const t = s.available_again_at ? ` until ${new Date(s.available_again_at).toISOString()}` : '';
        return `${a.label}: ${s.blockers.join('+')}${m}${t}`;
      })
      .join('; ');
    const timed = statuses.filter(({ s }) => s.available_again_at);
    if (!timed.length) {
      return { ok: false, status: 503, code: 'no_account', message: `no account can serve ${model.label} now [${why}]`, retryAfter: 600 };
    }
    const until = Math.min(...timed.map(({ s }) => s.available_again_at));
    return {
      ok: false,
      status: 429,
      code: 'capacity',
      message: `every account that offers ${model.label} is full or paused by Google [${why}]; next free at ${new Date(until).toISOString()}`,
      retryAfter: Math.max(1, Math.ceil((until - now) / 1000)),
    };
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
      if (!account && job.model.accounts.every((id) => job.tried.has(id))) {
        // Every account that offers the model was tried and none could take it (nothing was sent).
        this.#dequeue(job);
        job.reject(new HubError(503, 'no_account', `every account offering ${job.model.label} was tried and none could take the request now; nothing was sent`, { retryAfter: 60 }));
        continue;
      }
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

  /**
   * Rough wait for the n-th request in line for `model`: how long its recent jobs
   * took (median of the last 20 successful ones, 30 s when unknown) times the
   * rounds needed over the accounts that can take it now.
   */
  estimateWaitMs(model, position, now = Date.now()) {
    const rows = this.store
      .q("SELECT ms FROM usage WHERE model = ? AND status = 'ok' ORDER BY id DESC LIMIT 20")
      .all(model.id)
      .map((r) => Number(r.ms))
      .sort((a, b) => a - b);
    const typical = rows.length ? rows[Math.floor(rows.length / 2)] + 5_000 : 30_000;
    const accounts = this.store.accounts().filter((a) => model.accounts.includes(a.id) && !this.accountStatus(a, model, now).blockers.length).length;
    return Math.ceil(position / Math.max(1, accounts)) * typical;
  }

  /** Best free account for the job (see the sort below). */
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
    // Spread the load by Gemini's own meter (5-hour window, in 20-point steps), then
    // prefer an open browser, then the least recently used account.
    const band = (c) => Math.floor((c.s.meter.five_hour?.used_pct ?? 0) / 20);
    candidates.sort((x, y) => band(x) - band(y) || Number(y.rt.warm) - Number(x.rt.warm) || x.rt.lastUsed - y.rt.lastUsed);
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
      // Know before writing: an old meter reading is refreshed from the usage page first.
      if (meterState(this.store.account(account.id), this.config.usageStop ?? {}).stale) {
        const r = await g.readUsage();
        this.store.updateAccount(account.id, { usage: { meters: r.meters, read_at: Date.now() } });
        const fresh = meterState(this.store.account(account.id), this.config.usageStop ?? {});
        if (fresh.blockers.length) throw new UiError('meter_full', `usage meter at the stop line (${fresh.blockers.join('+')})`);
        step('meter');
      }
      g.onDrift = (role, message) => this.#drift(role, message);
      await g.newChat();
      if (this.config.chaos && rt.chaos) await g.applyChaos(rt.chaos);
      step('new_chat');
      const temporary = await g.temporaryChat();
      step('temporary');
      await g.selectModel(job.model.label);
      step('model');
      const thinking = await g.setThinking(job.thinking ?? this.config.defaultThinking ?? 'low');
      step('thinking');
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
        await g.send({ files: files.length > 0 });
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
      this.log('job_done', { account: account.id, model: job.model.id, thinking, temporary, via: answer.via, prompts, steps });
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
        thinking,
        via: answer.via,
        prompts,
        ms: Date.now() - started,
        queue_ms: started - job.queuedAt,
        usage: this.store.account(account.id)?.usage ?? {},
      });
    } catch (e) {
      if (e instanceof HubError) return job.reject(e);
      const err = e instanceof UiError ? e : new UiError('browser_error', e.message.split('\n')[0]);
      if (err.sent) sent = true;
      if (!sent) prompts = 0;
      err.steps = steps;
      await this.#onFailure(job, account, rt, err, sent);
      usage('error', err.code);
    } finally {
      rt.busy = false;
      rt.lastUsed = Date.now();
      rt.restUntil = Date.now() + (prompts ? restAfterMs(outChars) : 2000);
      // During the rest a person might glance at the usage page: refresh the meter
      // when it is older than 30 minutes (no cost to the caller, who already has the answer).
      const acct = this.store.account(account.id);
      const stale = prompts && acct?.state === 'ready' && Date.now() - (acct.usage?.read_at ?? 0) > 30 * 60_000;
      const after = stale ? this.readUsage(account.id).catch((e) => this.log('usage_read_failed', { account: account.id, error: e.message })) : Promise.resolve();
      this.#tick().catch(() => {});
      // One request = one use of the browser: close it as soon as no waiting request needs this account.
      after.finally(() => this.#closeIfIdle(account.id));
    }
  }

  async #closeIfIdle(id) {
    const rt = this.runtimes.get(id);
    if (!rt?.warm || rt.busy || rt.signin) return;
    if (this.queue.some((j) => j.model.accounts.includes(id) && !j.tried.has(id))) return;
    rt.busy = true;
    try {
      await rt.close('done');
    } finally {
      rt.busy = false;
    }
  }

  async #onFailure(job, account, rt, err, sent) {
    const now = Date.now();
    const id = account.id;
    this.log('job_failed', { account: id, model: job.model.id, code: err.code, sent, message: err.message, steps: err.steps });
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
          message: `Google showed a limit after ${used} prompts in 24 h. ${job.model.label} rests on this account until ${new Date(until).toISOString()}.`,
          accountId: id,
        });
        // The usage page says when the window really resets; read it now.
        setTimeout(() => this.readUsage(id).catch(() => {}), 1000);
        return sent ? fail(429, 'account_limit', 'the account reached a Gemini limit while answering; the prompt is not resent') : requeue();
      }
      case 'throttled': {
        // Google's "too many requests". A single one does not lock the account: the
        // request (nothing sent yet) is tried again 10 s later, here or on another
        // account. Only three within 10 minutes pause the account, for a few minutes.
        const recent = (rt.throttles = [...(rt.throttles ?? []).filter((t) => now - t < 10 * 60_000), now]);
        this.store.event('warn', 'account_throttled', id, { count_10min: recent.length, message: err.message });
        if (recent.length >= 3) {
          const until = now + cooldownMs(account.cooldown_until, now);
          this.store.updateAccount(id, { cooldown_until: until });
          rt.throttles = [];
          this.alerts.notify({
            key: `throttled:${id}`,
            title: `${account.label} slowed down by Google`,
            message: `Google answered "too many requests" (HTTP 429) three times in 10 minutes. ${account.label} pauses until ${new Date(until).toISOString()} and then resumes by itself.`,
            accountId: id,
          });
        }
        if (sent) return fail(429, 'account_throttled', 'Google rate-limited the account while answering; the prompt is not resent');
        rt.restUntil = now + 10_000;
        if (recent.length >= 3) job.tried.add(id);
        this.queue.unshift(job);
        return undefined;
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
      case 'meter_full':
        return requeue();
      case 'model_unavailable':
        this.refreshAccount(id).catch(() => {});
        return requeue();
      case 'model_changed':
        // After an answer it usually means Google moved the chat to another model (a limit):
        // that model rests 15 min on the account. Before sending, nothing is blocked.
        if (sent) this.store.setLimit(id, job.model.id, { exhausted_until: now + 15 * 60_000 });
        this.store.event('warn', 'model_changed', id, { model: job.model.id, sent, message: err.message });
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
      case 'generation_failed': {
        // A chat Google dropped without an answer is a quiet "slow down" when it repeats:
        // two within 30 minutes pause the account like three 429s do.
        if (err.dropped) {
          const drops = (rt.drops = [...(rt.drops ?? []).filter((t) => now - t < 30 * 60_000), now]);
          this.store.event('warn', 'answer_dropped', id, { model: job.model.id, count_30min: drops.length, message: err.message });
          if (drops.length >= 2) {
            const until = now + cooldownMs(account.cooldown_until, now);
            this.store.updateAccount(id, { cooldown_until: until });
            rt.drops = [];
            this.alerts.notify({
              key: `dropped:${id}`,
              title: `${account.label}: Gemini stopped answering`,
              message: `Gemini reset two chats in 30 minutes without an answer. ${account.label} pauses until ${new Date(until).toISOString()} and then resumes by itself.`,
              accountId: id,
            });
          }
        }
        return fail(502, 'generation_failed', err.message);
      }
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
      if (rt.warm && (now - rt.lastUsed > this.config.idleCloseMs || a.state !== 'ready')) {
        await rt.close('idle');
        continue;
      }
      // Keep the Google session fresh the way a person does: every 5-7 hours Gemini is
      // opened for about a minute, no prompt. Chrome itself then
      // rotates the session cookies, so an idle account is never signed out for staleness.
      const quietFor = now - Math.max(a.last_open_at, a.last_job_at);
      const visitEvery = (5 + ((a.id.charCodeAt(1) + Math.floor(now / 86_400_000)) % 3)) * HOUR;
      if (a.state === 'ready' && !rt.warm && quietFor > visitEvery) {
        rt.busy = true;
        try {
          const facts = await rt.inspect();
          await new Promise((r) => setTimeout(r, 45_000 + Math.random() * 45_000));
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
    // Tell the operator when every account of a model is nearly full (5-hour meter >= 85 %).
    if (now - (this.lastCapacityCheck ?? 0) > 30 * 60_000) {
      this.lastCapacityCheck = now;
      for (const c of this.capacity(now)) {
        const usable = c.accounts.filter((p) => !p.blockers.some((b) => ['new', 'paused', 'attention', 'no_model', 'model_disabled'].includes(b)));
        const nearlyFull = usable.length && usable.every((p) => (p.meter.five_hour?.used_pct ?? 0) >= 85 || p.blockers.length);
        if (nearlyFull || c.rejected_24h > 0) {
          this.alerts.notify({
            key: `capacity:${c.model}`,
            title: `${c.label}: accounts nearly full`,
            message: `Every account offering ${c.label} is at 85 % or more of its 5-hour Gemini allowance, or requests were refused (${c.rejected_24h} in 24 h). Add an account or lower the load.`,
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
