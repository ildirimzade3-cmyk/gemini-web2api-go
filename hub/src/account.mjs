// One Google account = one persistent Chrome profile on its own virtual display.
//
// Two ways the profile is opened, never both at once:
// - sign-in mode: a plain Google Chrome with no automation attached (no CDP, no
//   automation flags), shown to the operator through VNC on the loopback interface.
//   The operator signs in or answers a Google check exactly as on their own computer.
// - work mode: the same profile driven through a CDP pipe (no debugging port) to
//   answer prompts, one at a time.
// Google therefore sees one ordinary Chrome on one machine for each account.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'patchright-core';
import { GeminiPage, APP_URL } from './ui.mjs';

const SCREEN = { width: 1920, height: 1080 };
const CHROME_ARGS = [
  `--window-size=${SCREEN.width},${SCREEN.height - 40}`,
  '--window-position=0,0',
  '--password-store=basic',
  '--lang=en-US',
  '--no-first-run',
  '--no-default-browser-check',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited with ${c}`))));
  });
}

function waitExit(proc, ms) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    proc.once('exit', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

export class AccountRuntime {
  /** deps: { config, store, log(kind, detail), book, index } */
  constructor(account, deps) {
    this.id = account.id;
    this.deps = deps;
    this.display = `:${deps.config.displayBase + deps.index}`;
    this.vncPort = deps.config.vncPortBase + deps.index;
    this.profile = path.join(deps.config.profilesDir, account.id);
    this.xvfb = null;
    this.context = null;
    this.gpage = null;
    this.signin = null; // { chrome, vnc, password, startedAt }
    this.busy = false;
    this.lastUsed = 0;
    this.restUntil = 0;
  }

  get warm() {
    return Boolean(this.context);
  }

  log(kind, detail = {}) {
    this.deps.log(kind, { account: this.id, ...detail });
  }

  /**
   * Starts this account's virtual display. Access needs the display's own random
   * cookie (no "-ac"): with host networking the abstract X socket is visible to
   * other host processes, so the cookie is what keeps the screen private.
   */
  async #ensureDisplay() {
    if (this.xvfb && this.xvfb.exitCode === null) return;
    const lock = `/tmp/.X${this.display.slice(1)}-lock`;
    fs.rmSync(lock, { force: true });
    this.xauth = path.join('/tmp', `xauth-${this.id}`);
    fs.writeFileSync(this.xauth, '', { mode: 0o600 });
    await run('xauth', ['-f', this.xauth, 'add', this.display, '.', crypto.randomBytes(16).toString('hex')]);
    this.xvfb = spawn('Xvfb', [this.display, '-screen', '0', `${SCREEN.width}x${SCREEN.height}x24`, '-nolisten', 'tcp', '-auth', this.xauth], {
      stdio: 'ignore',
    });
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      if (this.xvfb.exitCode !== null) throw new Error(`Xvfb ${this.display} exited`);
      if (fs.existsSync(lock)) return;
    }
  }

  get xenv() {
    return { ...process.env, DISPLAY: this.display, XAUTHORITY: this.xauth };
  }

  #stopDisplay() {
    this.xvfb?.kill('SIGTERM');
    this.xvfb = null;
    if (this.xauth) fs.rmSync(this.xauth, { force: true });
  }

  // --- work mode -----------------------------------------------------------

  /** Opens the profile for work (no-op when it is open). Returns the GeminiPage. */
  async open() {
    if (this.signin) throw Object.assign(new Error('the sign-in view is open for this account'), { code: 'signin_open' });
    if (this.context) return this.gpage;
    fs.mkdirSync(this.profile, { recursive: true, mode: 0o700 });
    await this.#ensureDisplay();
    const t0 = Date.now();
    this.context = await chromium.launchPersistentContext(this.profile, {
      executablePath: this.deps.config.chromePath,
      headless: false,
      chromiumSandbox: true,
      viewport: null,
      locale: 'en-US',
      env: this.xenv,
      ignoreDefaultArgs: ['--enable-automation'],
      args: CHROME_ARGS,
    });
    this.context.on('close', () => {
      this.context = null;
      this.gpage = null;
    });
    await this.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://gemini.google.com' });
    // One tab, like a person keeping Gemini open.
    const pages = this.context.pages();
    const page = pages[0] ?? (await this.context.newPage());
    for (const extra of pages.slice(1)) await extra.close().catch(() => {});
    const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone).catch(() => 'UTC');
    this.gpage = new GeminiPage(page, {
      book: this.deps.book,
      log: (k, d) => this.log(k, d),
      repairKey: this.deps.config.repairApiKey,
      repairModel: this.deps.config.repairModel,
      tz,
    });
    this.log('browser_open', { ms: Date.now() - t0 });
    this.deps.store.updateAccount(this.id, { last_open_at: Date.now() });
    return this.gpage;
  }

  async close(reason = 'idle') {
    const ctx = this.context;
    this.context = null;
    this.gpage = null;
    if (ctx) {
      await ctx.close().catch(() => {});
      this.log('browser_closed', { reason });
    }
    if (!this.signin) this.#stopDisplay();
  }

  /** Opens Gemini and reads who is signed in, the plan and the model catalogue. */
  async inspect() {
    const g = await this.open();
    await g.open();
    const facts = await g.accountFacts();
    let models = [];
    if (facts.signed_in) models = await g.models();
    return { ...facts, models };
  }

  // --- sign-in mode --------------------------------------------------------

  /**
   * Starts plain Chrome (no automation) on this account's display and a VNC server
   * on 127.0.0.1 with a one-time password. Returns { port, password }.
   */
  async startSignIn() {
    if (this.busy) throw Object.assign(new Error('the account is answering a prompt; try again in a moment'), { code: 'busy' });
    if (this.signin) return { port: this.vncPort, password: this.signin.password };
    await this.close('sign-in');
    fs.mkdirSync(this.profile, { recursive: true, mode: 0o700 });
    await this.#ensureDisplay();
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.rmSync(path.join(this.profile, f), { force: true });
    const chrome = spawn(this.deps.config.chromePath, [`--user-data-dir=${this.profile}`, ...CHROME_ARGS, APP_URL], {
      env: this.xenv,
      stdio: 'ignore',
    });
    const password = crypto.randomBytes(6).toString('base64url').slice(0, 8); // VNC passwords are 8 characters
    const pwFile = path.join('/tmp', `vnc-${this.id}.pass`);
    await run('x11vnc', ['-storepasswd', password, pwFile]);
    fs.chmodSync(pwFile, 0o600);
    const vnc = spawn(
      'x11vnc',
      ['-display', this.display, '-auth', this.xauth, '-rfbport', String(this.vncPort), '-localhost', '-rfbauth', pwFile, '-forever', '-shared', '-noxdamage', '-quiet'],
      { stdio: 'ignore' },
    );
    this.signin = { chrome, vnc, password, pwFile, startedAt: Date.now() };
    chrome.once('exit', () => this.log('signin_chrome_exit'));
    this.log('signin_started');
    await sleep(1200);
    return { port: this.vncPort, password };
  }

  /**
   * Whether the sign-in Chrome holds a Google session yet: looks only at cookie
   * NAMES in a copy of the profile's cookie store (values stay encrypted and unread).
   */
  signInSeen() {
    const src = path.join(this.profile, 'Default', 'Cookies');
    if (!fs.existsSync(src)) return false;
    const copy = path.join('/tmp', `cookies-${this.id}.db`);
    try {
      fs.copyFileSync(src, copy);
      const db = new DatabaseSync(copy, { readOnly: true });
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM cookies WHERE host_key LIKE '%google.com' AND name IN ('SID', '__Secure-1PSID', '__Secure-3PSID')")
        .get();
      db.close();
      return Number(row.n) > 0;
    } catch {
      return false;
    } finally {
      fs.rmSync(copy, { force: true });
    }
  }

  /** Closes the sign-in Chrome gracefully (so the session is written to disk) and the VNC server. */
  async stopSignIn() {
    const s = this.signin;
    if (!s) return;
    this.signin = null;
    s.chrome.kill('SIGTERM');
    if (!(await waitExit(s.chrome, 15_000))) s.chrome.kill('SIGKILL');
    // x11vnc may ignore SIGTERM; a VNC server left running would keep a door to this
    // account's screen open, so it is killed for certain and the exit is awaited.
    s.vnc.kill('SIGTERM');
    if (!(await waitExit(s.vnc, 3000))) {
      s.vnc.kill('SIGKILL');
      await waitExit(s.vnc, 3000);
    }
    fs.rmSync(s.pwFile, { force: true });
    this.#stopDisplay();
    this.log('signin_stopped', { minutes: Math.round((Date.now() - s.startedAt) / 60000) });
  }

  async shutdown() {
    await this.stopSignIn();
    await this.close('shutdown');
  }
}
