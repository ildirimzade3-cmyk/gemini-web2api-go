// Admin side: loopback and the tailnet address only (HUB_ADMIN_LISTEN), never public.
// - refuses any peer that is not loopback or a tailnet device and any Host header other
//   than the listen addresses (no DNS rebinding), needs the admin token or a single-use
//   link, then a session cookie (HttpOnly, SameSite=Strict) plus a CSRF header on every change;
// - the sign-in view is noVNC over a WebSocket that is proxied only to the VNC
//   server of the account being signed in, only for a logged-in admin session.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { ipInCidrs, normalizeIp, randomToken, sha256, timingSafeEqualStr, parseCidr } from './security.mjs';
import { HubError } from './scheduler.mjs';
import { ADMIN_HTML, VIEWER_HTML } from './admin-ui.mjs';

const NOVNC_DIR = '/opt/novnc';
// Admin sessions live in the database (hashed) so a hub restart does not log the operator out.
const SESSION_MS = 30 * 86_400_000;
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1';
}

const TAILNET = [parseCidr('100.64.0.0/10')];
/** Admin side: loopback or a tailnet device (WireGuard-authenticated), never anything else. */
function isPrivateAdminPeer(ip) {
  return isLoopback(ip) || ipInCidrs(ip, TAILNET);
}

export class AdminServer {
  constructor({ config, store, scheduler, log }) {
    Object.assign(this, { config, store, scheduler, log });
    this.listen = config.adminListen.map((addr) => {
      const i = addr.lastIndexOf(':');
      const host = addr.slice(0, i);
      if (!isPrivateAdminPeer(host)) throw new Error(`admin address ${addr} is neither loopback nor tailnet`);
      return { addr, host, port: Number(addr.slice(i + 1)) };
    });
    // Host headers this page answers to (anti DNS rebinding).
    this.hosts = new Set(this.listen.flatMap(({ host, port }) => (isLoopback(host) ? [`127.0.0.1:${port}`, `localhost:${port}`] : [`${host}:${port}`])));
    this.failures = 0;
  }

  start() {
    this.server = http.createServer((req, res) =>
      this.#handle(req, res).catch((e) => {
        this.log('admin_error', { error: e.message });
        this.#json(res, e instanceof HubError ? e.status : 500, { error: e.message });
      }),
    );
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, sock, head) => this.#upgrade(req, sock, head));
    this.servers = [this.server];
    const handler = this.server.listeners('request')[0];
    for (const [n, l] of this.listen.entries()) {
      const srv = n === 0 ? this.server : http.createServer(handler);
      if (n > 0) {
        srv.on('upgrade', (req, sock, head) => this.#upgrade(req, sock, head));
        this.servers.push(srv);
      }
      // The tailnet address may not exist yet at boot: retry until it does.
      srv.on('error', (e) => {
        this.log('admin_listen_retry', { addr: l.addr, error: e.code || e.message });
        setTimeout(() => srv.listen(l.port, l.host), 30_000);
      });
      srv.listen(l.port, l.host, () => this.log('admin_listening', { addr: l.addr }));
    }
  }

  stop() {
    return Promise.all(this.servers.map((s) => new Promise((r) => s.close(r))));
  }

  #guard(req) {
    return isPrivateAdminPeer(normalizeIp(req.socket.remoteAddress)) && this.hosts.has(String(req.headers.host ?? '').toLowerCase());
  }

  #session(req) {
    const m = /(?:^|;\s*)hub_admin=([A-Za-z0-9]+)/.exec(req.headers.cookie ?? '');
    if (!m) return null;
    const key = sha256(m[1]);
    const s = this.store.get('admin_sessions', []).find((x) => x.key === key && x.exp > Date.now());
    return s ?? null;
  }

  #json(res, status, obj, headers = {}) {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(obj));
  }

  #html(res, html) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    });
    res.end(html);
  }

  async #body(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > 1_000_000) throw new HubError(413, 'too_large', 'body too large');
      chunks.push(c);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  async #handle(req, res) {
    if (!this.#guard(req)) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url, 'http://admin');
    const p = url.pathname;
    if (req.method === 'GET' && p === '/') return this.#html(res, ADMIN_HTML);
    if (req.method === 'POST' && p === '/login') return this.#login(req, res);
    if (req.method === 'GET' && p.startsWith('/novnc/')) return this.#static(res, p.slice('/novnc/'.length));

    const s = this.#session(req);
    if (!s) return this.#json(res, 401, { error: 'login required' });
    if (req.method !== 'GET' && !timingSafeEqualStr(String(req.headers['x-csrf'] ?? ''), s.csrf)) return this.#json(res, 403, { error: 'bad csrf' });
    if (req.method === 'GET' && p.startsWith('/viewer/')) return this.#html(res, VIEWER_HTML);
    if (req.method === 'GET' && p === '/api/state') return this.#json(res, 200, this.#state(s));
    const outline = /^\/api\/accounts\/(a\d+)\/outline$/.exec(p);
    if (req.method === 'GET' && outline) {
      const g = this.scheduler.runtimes.get(outline[1])?.gpage;
      if (!g) return this.#json(res, 409, { error: 'the work browser of this account is closed' });
      return this.#json(res, 200, await g.diagnostic());
    }
    const shot = /^\/api\/accounts\/(a\d+)\/screenshot$/.exec(p);
    if (req.method === 'GET' && shot) return this.#screenshot(res, shot[1]);
    if (req.method === 'POST' && p === '/logout') {
      this.store.set('admin_sessions', this.store.get('admin_sessions', []).filter((x) => x.key !== s.key));
      return this.#json(res, 200, { ok: true }, { 'set-cookie': 'hub_admin=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict' });
    }

    const body = req.method === 'POST' ? await this.#body(req) : {};
    let m;
    if (req.method === 'POST' && p === '/api/accounts') return this.#json(res, 200, this.scheduler.addAccount(String(body.label ?? '').slice(0, 40)));
    if ((m = /^\/api\/accounts\/(a\d+)\/signin-status$/.exec(p)) && req.method === 'GET') {
      const rt = this.scheduler.runtimes.get(m[1]);
      const acct = this.store.account(m[1]);
      return this.#json(res, 200, {
        open: Boolean(rt?.signin),
        signed_in: Boolean(rt?.signin && rt.signInSeen()),
        state: acct?.state,
        identity: acct?.identity,
        models: acct?.models?.length ?? 0,
      });
    }
    if ((m = /^\/api\/accounts\/(a\d+)\/(signin|done|refresh|pause|resume|remove)$/.exec(p)) && req.method === 'POST') {
      return this.#json(res, 200, await this.#accountAction(m[1], m[2], body));
    }
    if ((m = /^\/api\/accounts\/(a\d+)\/chaos$/.exec(p)) && req.method === 'POST') {
      if (!this.config.chaos) return this.#json(res, 404, { error: 'not found' });
      const rt = this.scheduler.runtimes.get(m[1]);
      if (!rt) return this.#json(res, 404, { error: 'no such account' });
      rt.chaos = ['input', 'copy', 'send'].includes(body.kind) ? body.kind : null;
      this.store.event('warn', 'chaos_set', m[1], { kind: rt.chaos });
      return this.#json(res, 200, { chaos: rt.chaos });
    }
    if ((m = /^\/api\/accounts\/(a\d+)\/usage$/.exec(p)) && req.method === 'POST') return this.#json(res, 200, await this.scheduler.readUsage(m[1], { raw: true }));
    if (req.method === 'POST' && p === '/api/apps') return this.#json(res, 200, this.#createApp(body));
    if ((m = /^\/api\/apps\/([\w-]+)\/(revoke|update)$/.exec(p)) && req.method === 'POST') return this.#json(res, 200, this.#appAction(m[1], m[2], body));
    if (req.method === 'POST' && p === '/api/test-alert') {
      await this.scheduler.alerts.notify({ key: `test:${Date.now()}`, title: 'test', message: 'Test alert from the Gemini hub admin page.', everyMs: 0 });
      return this.#json(res, 200, { ok: true, topic_set: Boolean(this.config.ntfyTopic) });
    }
    return this.#json(res, 404, { error: 'not found' });
  }

  async #login(req, res) {
    const body = await this.#body(req).catch(() => ({}));
    const hash = this.store.get('admin_token_hash');
    if (this.failures >= 20) return this.#json(res, 429, { error: 'too many attempts; restart the hub to reset' });
    if (typeof body.otc === 'string' && this.#useLoginCode(body.otc)) body.token = null;
    else if (!hash || typeof body.token !== 'string' || !timingSafeEqualStr(sha256(body.token), hash)) {
      this.failures += 1;
      this.store.event('warn', 'admin_login_failed', null, {});
      await new Promise((r) => setTimeout(r, 800));
      return this.#json(res, 401, { error: 'wrong token' });
    }
    this.failures = 0;
    const raw = crypto.randomBytes(32).toString('hex');
    const key = sha256(raw);
    const csrf = crypto.randomBytes(24).toString('hex');
    const live = this.store.get('admin_sessions', []).filter((x) => x.exp > Date.now()).slice(-9);
    this.store.set('admin_sessions', [...live, { key, csrf, exp: Date.now() + SESSION_MS }]);
    this.store.event('info', 'admin_login', null, {});
    return this.#json(res, 200, { csrf }, { 'set-cookie': `hub_admin=${raw}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; SameSite=Strict` });
  }

  /** One-time login codes from `cli.mjs login-link`: single use, 10 minutes. */
  #useLoginCode(code) {
    const codes = this.store.get('login_codes', []);
    const h = sha256(code);
    const hit = codes.find((c) => c.h === h && c.exp > Date.now());
    this.store.set('login_codes', codes.filter((c) => c.h !== h && c.exp > Date.now()));
    return Boolean(hit);
  }

  #static(res, rel) {
    const file = path.normalize(path.join(NOVNC_DIR, rel));
    if (!file.startsWith(NOVNC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'max-age=3600' });
    fs.createReadStream(file).pipe(res);
  }

  /** What the account's work browser shows right now (admin only, never stored). */
  async #screenshot(res, id) {
    const page = this.scheduler.runtimes.get(id)?.gpage?.page;
    if (!page) return this.#json(res, 409, { error: 'the work browser of this account is closed' });
    const png = await page.screenshot({ type: 'png' });
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    res.end(png);
  }

  #state(s) {
    const accounts = this.store.accounts().map((a) => {
      const rt = this.scheduler.runtimes.get(a.id);
      return {
        id: a.id,
        label: a.label,
        state: a.state,
        state_reason: a.state_reason,
        state_since: a.state_since,
        plan: a.plan,
        plan_label: a.plan_label,
        identity: a.identity,
        models: a.models,
        last_job_at: a.last_job_at,
        warm: Boolean(rt?.warm),
        busy: Boolean(rt?.busy),
        signin: Boolean(rt?.signin),
        limits: this.store.limitsFor(a.id),
        usage: a.usage,
      };
    });
    const apps = this.store.apps().map(({ key_hash, path_hash, ...rest }) => ({ ...rest, public: Boolean(path_hash) }));
    return {
      csrf: s.csrf,
      now: Date.now(),
      accounts,
      apps,
      capacity: this.scheduler.capacity(),
      queue: this.scheduler.queue.map((j) => ({ app: j.app.name, model: j.model.id, waiting_ms: Date.now() - j.queuedAt })),
      usage24h: this.store.usageSummary(Date.now() - 86_400_000),
      events: this.store.events(150),
      alerts: { ntfy_topic_set: Boolean(this.config.ntfyTopic) },
    };
  }

  async #accountAction(id, action, body) {
    const a = this.store.account(id);
    if (!a) throw new HubError(404, 'not_found', 'no such account');
    switch (action) {
      case 'signin': {
        const r = await this.scheduler.startSignIn(id);
        return { viewer: `/viewer/${id}`, password: r.password };
      }
      case 'done':
        return this.scheduler.finishSignIn(id);
      case 'refresh':
        return this.scheduler.refreshAccount(id);
      case 'pause':
        this.scheduler.setState(id, 'paused', 'paused by the operator');
        await this.scheduler.runtimes.get(id)?.close('paused');
        return this.store.account(id);
      case 'resume':
        // Back to work after the operator's pause; the check below demotes it again if signed out.
        this.scheduler.setState(id, 'ready', 'resumed by the operator');
        return this.scheduler.refreshAccount(id);
      case 'remove':
        if (body.confirm !== id) throw new HubError(400, 'confirm', 'send {"confirm": "<account id>"} to remove');
        await this.scheduler.removeAccount(id);
        return { removed: id };
      default:
        throw new HubError(404, 'not_found', 'unknown action');
    }
  }

  #createApp(body) {
    const name = String(body.name ?? '').trim();
    if (!/^[\w.-]{2,40}$/.test(name)) throw new HubError(400, 'bad_name', 'name: 2-40 letters, digits, . _ -');
    const cidrs = String(body.cidrs ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const isPublic = body.public === true || body.public === 'true';
    if (isPublic && !this.config.publicUrl) throw new HubError(400, 'no_public_url', 'the public link is not configured (HUB_PUBLIC_URL)');
    if (!cidrs.length && !isPublic) throw new HubError(400, 'bad_cidrs', 'give a source address/CIDR, or tick the public link');
    for (const c of cidrs) parseCidr(c);
    const models = String(body.models ?? '*').trim() || '*';
    const cap = body.daily_cap === '' || body.daily_cap == null ? null : Number(body.daily_cap);
    if (cap !== null && !(Number.isInteger(cap) && cap > 0)) throw new HubError(400, 'bad_cap', 'daily_cap must be a positive integer');
    const key = randomToken('ghk_');
    const secret = isPublic ? randomToken('', 24) : null;
    const app = {
      id: `app_${crypto.randomBytes(4).toString('hex')}`,
      name,
      key_hash: sha256(key),
      key_hint: `${key.slice(0, 8)}…${key.slice(-4)}`,
      cidrs: cidrs.join(','),
      models,
      daily_cap: cap,
      created_at: Date.now(),
      path_hash: secret ? sha256(secret) : null,
    };
    this.store.insertApp(app);
    this.store.event('info', 'app_created', null, { app: app.id, name, cidrs: app.cidrs, public: isPublic });
    const out = { id: app.id, name, key, note: 'The key (and the link) are shown only now.' };
    if (secret) {
      out.openai_base_url = `${this.config.publicUrl}/p/${secret}/v1`;
      out.gemini_base_url = `${this.config.publicUrl}/p/${secret}`;
    }
    if (cidrs.length) out.private_sources = app.cidrs;
    return out;
  }

  #appAction(id, action, body) {
    const app = this.store.apps().find((a) => a.id === id);
    if (!app) throw new HubError(404, 'not_found', 'no such app');
    if (action === 'revoke') {
      this.store.updateApp(id, { revoked_at: Date.now() });
      this.store.event('warn', 'app_revoked', null, { app: id });
      return { revoked: id };
    }
    const fields = {};
    if (body.cidrs != null) {
      const cidrs = String(body.cidrs).split(',').map((s) => s.trim()).filter(Boolean);
      for (const c of cidrs) parseCidr(c);
      if (!cidrs.length) throw new HubError(400, 'bad_cidrs', 'at least one CIDR');
      fields.cidrs = cidrs.join(',');
    }
    if (body.models != null) fields.models = String(body.models).trim() || '*';
    if (body.daily_cap !== undefined) fields.daily_cap = body.daily_cap === '' || body.daily_cap === null ? null : Number(body.daily_cap);
    this.store.updateApp(id, fields);
    return { updated: id };
  }

  #upgrade(req, sock, head) {
    const m = /^\/vnc\/(a\d+)$/.exec(new URL(req.url, 'http://admin').pathname);
    const origin = String(req.headers.origin ?? '');
    const okOrigin = [...this.hosts].some((h) => origin === `http://${h}`);
    const rt = m && this.scheduler.runtimes.get(m[1]);
    if (!this.#guard(req) || !okOrigin || !this.#session(req) || !rt?.signin) {
      sock.destroy();
      return;
    }
    this.wss.handleUpgrade(req, sock, head, (ws) => {
      const tcp = net.connect(rt.vncPort, '127.0.0.1');
      tcp.on('data', (d) => ws.readyState === ws.OPEN && ws.send(d));
      ws.on('message', (d) => tcp.write(d));
      const end = () => {
        tcp.destroy();
        ws.close();
      };
      tcp.on('close', end);
      tcp.on('error', end);
      ws.on('close', end);
    });
  }
}
