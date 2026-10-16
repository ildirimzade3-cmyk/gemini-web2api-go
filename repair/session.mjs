// One headless Chromium with the account cookies, and the UI actions both modes
// share: open a chat, read page facts and the model menu, pick a model, attach
// files, type and send a prompt, wait for the finished answer and read it.
//
// Selectors come from an ordered default list; when they stop matching, the
// official Gemini API proposes new ones (ai.mjs). Learned selectors are kept in
// memory in a SelectorBook and reported through `onSelectorsLearned`.

import { chromium } from 'playwright-core';
import { classifyUiMessage, pickJsonText } from './answer.mjs';
import {
  collectAnswerOutline,
  collectPageSummary,
  proposeAnswerSelectors,
  proposeSelectors,
  trimSummary,
} from './ai.mjs';
import { collectAlerts, collectDomFacts, collectModelMenu, readChatState } from './dom.mjs';
import { derivePageFacts, findModel, parseModelItems, parsePickerLabel } from './facts.mjs';

export const APP_URL = 'https://gemini.google.com/app';
export const DEFAULT_CEILING_MS = 600_000;
/** Prompts above this many bytes are attached as a .txt file instead of being typed. */
export const ATTACH_THRESHOLD_BYTES = 30 * 1024;
export const ATTACHED_PROMPT_INSTRUCTION =
  'The attached file prompt.txt holds my complete request. Carry out the request in that file exactly and reply with only what it asks for.';

// Ordered, most specific first. Role/aria/contenteditable based; no generated class names
// except the long-lived Quill editor class.
export const DEFAULT_SELECTORS = Object.freeze({
  input: [
    'rich-textarea div.ql-editor[contenteditable="true"]',
    'div.ql-editor[contenteditable="true"]',
    '[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"][aria-label*="prompt" i]',
    'div[contenteditable="true"][aria-label*="message" i]',
    'textarea[aria-label*="prompt" i]',
    'textarea',
    '[contenteditable="true"]',
  ],
  send: [
    'button[aria-label*="send message" i]',
    'button[aria-label="Send"]',
    'button.send-button',
    'button[aria-label*="send" i]:not([aria-label*="feedback" i])',
  ],
  // The last match is the newest answer. message-content is the final answer text only
  // (no thinking panel, no action buttons).
  answer: ['model-response message-content', 'model-response .markdown', 'model-response'],
  stop: ['button[aria-label="Stop response"]', 'button[aria-label*="stop response" i]', 'button[aria-label*="stop generating" i]'],
});

const PICKER_SELECTORS = ['button[data-test-id="bard-mode-menu-button"]', 'button[aria-label^="Open mode picker" i]'];
const MODEL_ITEM_SELECTOR = '[data-test-id^="bard-mode-option-"]';
const UPLOAD_MENU_SELECTORS = ['button[aria-label="Upload & tools"]', 'button[aria-label*="upload" i]'];
const UPLOADER_SELECTOR = '[data-test-id="local-images-files-uploader-button"], [data-test-id="hidden-local-file-upload-button"]';
const CONVERSATION_PATH_RE = /^\/app\/[0-9a-f]{8,}$/i;

// Privacy first: reject non-essential cookies, never accept terms/agreements.
const REJECT_RE =
  /^(reject all|reject|decline all|deny all|alle ablehnen|tout refuser|rechazar todo|rifiuta tutto|t[üu]m[üu]n[üu] reddet|hamısını rədd et|отклонить все|odrzuć wszystko)\b/i;
const DISMISS_RE = /^(no thanks|not now|maybe later|dismiss|skip|close)$/i;

/** Failure with a code from the bridge's vocabulary (upstream_*, no_valid_account, ...). */
export class UiError extends Error {
  constructor(code, message, diagnostic) {
    super(message);
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

export class SelectorBook {
  #defaults;
  #learned = {};
  constructor(defaults = DEFAULT_SELECTORS) {
    this.#defaults = defaults;
  }

  /** Learned selectors first, then the defaults. */
  list(kind) {
    const learned = this.#learned[kind] ?? [];
    return [...learned, ...this.#defaults[kind].filter((s) => !learned.includes(s))];
  }

  /** Returns true when the selector is new. */
  learn(kind, selector) {
    if (!selector || this.#learned[kind]?.includes(selector)) return false;
    (this.#learned[kind] ??= []).unshift(selector);
    return true;
  }

  forget(kind, selector) {
    this.#learned[kind] = (this.#learned[kind] ?? []).filter((s) => s !== selector);
    if (!this.#learned[kind].length) delete this.#learned[kind];
  }

  /** Learned selectors only (safe to report: CSS selectors, nothing else). */
  learned() {
    return JSON.parse(JSON.stringify(this.#learned));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildUserAgent(version) {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

/** Playwright cookie objects for .google.com from the bridge's cookie list. */
export function toPlaywrightCookies(cookies) {
  const out = [];
  for (const c of cookies ?? []) {
    if (!c?.name || typeof c.value !== 'string') continue;
    const domain = c.domain || '.google.com';
    if (!/(^|\.)google\.com$/i.test(domain)) continue;
    const base = { name: c.name, value: c.value, secure: c.secure !== false, httpOnly: Boolean(c.httpOnly) };
    // __Host- cookies must not carry a Domain attribute, so they are set by URL.
    out.push(
      c.name.startsWith('__Host-')
        ? { ...base, url: `https://${domain.replace(/^\./, '')}/`, secure: true }
        : { ...base, domain, path: c.path || '/' },
    );
  }
  return out;
}

async function clickFirstVisible(locator) {
  const n = Math.min(await locator.count(), 5);
  for (let i = 0; i < n; i++) {
    const el = locator.nth(i);
    if (await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 3000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

/** One pass over consent dialogs and promo popups on every frame. Returns what was clicked. */
async function dismissDialogs(page) {
  const clicked = [];
  for (const frame of page.frames()) {
    for (const [kind, re] of [['reject', REJECT_RE], ['dismiss', DISMISS_RE]]) {
      const btn = frame.getByRole('button', { name: re });
      if (await clickFirstVisible(btn).catch(() => false)) clicked.push(kind);
    }
  }
  return clicked;
}

/** Polls the selector list in order until one is visible. Returns { selector, locator } or null. */
async function waitForFirst(page, selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastDialogPass = 0;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        const locator = page.locator(selector).first();
        if ((await locator.count()) > 0 && (await locator.isVisible())) return { selector, locator };
      } catch {
        // invalid selector (AI proposal): treat as no match
      }
    }
    if (Date.now() - lastDialogPass > 2000) {
      lastDialogPass = Date.now();
      await dismissDialogs(page);
    }
    await sleep(400);
  }
  return null;
}

async function pageDiagnostic(page) {
  try {
    const u = new URL(page.url());
    const headings = await page
      .locator('h1, h2, [role="heading"], [role="alert"], button')
      .evaluateAll((els) => els.map((e) => (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)).filter(Boolean).slice(0, 12));
    return { url: u.origin + u.pathname, title: (await page.title()).slice(0, 100), visible_text: headings };
  } catch {
    return { url: 'unknown' };
  }
}

/** Maps a classified UI message to the error the HTTP layer reports. */
function uiMessageError(kind, where) {
  if (kind === 'rate_limited') return new UiError('upstream_rate_limited', `Gemini reported a usage limit (${where})`);
  if (kind === 'sign_in_required') return new UiError('no_valid_account', `Gemini asked to sign in (${where})`);
  return new UiError('upstream_unavailable', `Gemini reported a failure (${where})`);
}

const DEFAULT_TIMING = Object.freeze({
  poll: 400, // between two looks at the page while waiting for an answer
  stable: 1200, // the answer text must stay unchanged this long
  aiAfter: 8000, // no answer container this long -> ask the AI for selectors
  aiVerify: 5000, // the AI-proposed answer selector must match within this
  giveUpAfter: 25000, // no answer container this long without an AI key -> protocol changed
});

export class BrowserSession {
  /**
   * opts: { cookies, chromiumPath, noSandbox, aiKey, aiModel, fetchImpl, log, book,
   *         onSelectorsLearned(selectors), timing (overrides of DEFAULT_TIMING, for tests) }
   */
  constructor(opts = {}) {
    this.pwCookies = toPlaywrightCookies(opts.cookies);
    this.secrets = (opts.cookies ?? []).map((c) => c?.value).filter(Boolean);
    this.chromiumPath = opts.chromiumPath;
    this.noSandbox = Boolean(opts.noSandbox);
    this.aiKey = opts.aiKey || '';
    this.aiModel = opts.aiModel;
    this.fetchImpl = opts.fetchImpl;
    this.log = opts.log ?? (() => {});
    this.book = opts.book ?? new SelectorBook();
    this.onSelectorsLearned = opts.onSelectorsLearned ?? (() => {});
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.browser = null;
    this.context = null;
    this.userAgent = '';
    /** Last signed-in state seen on a loaded page (null before the first page). */
    this.signedIn = null;
    /** "selectors" until the AI fallback had to be used, then "ai-selectors". */
    this.method = 'selectors';
  }

  get anonymous() {
    return this.pwCookies.length === 0;
  }

  isAlive() {
    return Boolean(this.browser?.isConnected());
  }

  async start() {
    this.browser = await chromium.launch({
      headless: true,
      executablePath: this.chromiumPath || undefined,
      args: ['--disable-dev-shm-usage', ...(this.noSandbox ? ['--no-sandbox'] : [])],
    });
    this.userAgent = buildUserAgent(this.browser.version());
    this.context = await this.browser.newContext({
      userAgent: this.userAgent,
      locale: 'en-US',
      viewport: { width: 1366, height: 900 },
    });
    if (this.pwCookies.length) await this.context.addCookies(this.pwCookies);
  }

  /** Starts the browser when it is not running (first use, or after a crash). */
  async ensureStarted() {
    if (this.isAlive()) return;
    await this.close();
    this.log('browser_start');
    await this.start();
  }

  async close() {
    const b = this.browser;
    this.browser = null;
    this.context = null;
    await b?.close().catch(() => {});
  }

  #learn(kind, selector) {
    if (this.book.learn(kind, selector)) {
      this.method = 'ai-selectors';
      this.log('selector_learned', { kind, selector });
      this.onSelectorsLearned(this.book.learned());
    }
  }

  /** Opens a fresh page on /app (a new chat) and waits for the prompt box. */
  async openChat() {
    await this.ensureStarted();
    const page = await this.context.newPage();
    try {
      let status = 0;
      try {
        status = (await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }))?.status() ?? 0;
      } catch (e) {
        throw new UiError('upstream_unavailable', `loading ${APP_URL} failed: ${e.message.split('\n')[0]}`);
      }
      if (status === 429) throw new UiError('upstream_rate_limited', 'gemini.google.com answered HTTP 429');
      if (status >= 500) throw new UiError('upstream_unavailable', `gemini.google.com answered HTTP ${status}`);
      const u = new URL(page.url());
      if (u.pathname.startsWith('/sorry')) throw new UiError('upstream_rate_limited', 'Google served its "unusual traffic" page');
      if (u.host === 'accounts.google.com') {
        throw new UiError(this.anonymous ? 'upstream_unavailable' : 'no_valid_account', 'redirected to the Google sign-in page');
      }
      this.log('page_loaded', { path: u.pathname });
      await this.#findInput(page);
      return page;
    } catch (e) {
      await page.close().catch(() => {});
      throw e;
    }
  }

  async #findInput(page) {
    let found = await waitForFirst(page, this.book.list('input'), 20000);
    if (found) return found;
    this.log('selectors_failed', { kind: 'input' });
    if (!this.aiKey) {
      throw new UiError('upstream_protocol_changed', 'prompt box not found and no GEMINI_REPAIR_API_KEY for the AI fallback', await pageDiagnostic(page));
    }
    const proposal = await this.#propose(page, 'input');
    found = await waitForFirst(page, [proposal.input_selector], 10000);
    if (!found) throw new UiError('upstream_protocol_changed', 'AI-proposed prompt box selector did not match', await pageDiagnostic(page));
    this.#learn('input', proposal.input_selector);
    if (proposal.send_selector) this.#learn('send', proposal.send_selector);
    return found;
  }

  /** Runs the AI selector proposal for `kind` ("input" or "answer"); failures become UiError. */
  async #propose(page, kind) {
    const opts = { apiKey: this.aiKey, model: this.aiModel, fetchImpl: this.fetchImpl };
    try {
      if (kind === 'answer') {
        return await proposeAnswerSelectors(trimOutline(await page.evaluate(collectAnswerOutline)), opts);
      }
      return await proposeSelectors(trimSummary(await page.evaluate(collectPageSummary)), opts);
    } catch (e) {
      throw new UiError('upstream_protocol_changed', `AI selector proposal failed: ${e.message}`, await pageDiagnostic(page));
    }
  }

  /** { bl, xsrf_present, signed_in, picker_label } of the loaded page. */
  async readFacts(page) {
    const [source, dom] = await Promise.all([page.content(), page.evaluate(collectDomFacts)]);
    const facts = derivePageFacts({ source, dom });
    this.signedIn = facts.signed_in;
    return facts;
  }

  /** Label the mode picker button shows right now ("Flash-Lite"), or "". */
  async pickerLabel(page) {
    try {
      return parsePickerLabel((await page.evaluate(collectDomFacts)).picker_label);
    } catch {
      return '';
    }
  }

  async #openModelMenu(page) {
    // The picker renders a second or two after the prompt box.
    const picker = await waitForFirst(page, PICKER_SELECTORS, 12000);
    if (!picker) return null;
    // A click that lands before the page wired the button opens nothing: retry a few times.
    for (let attempt = 0; attempt < 3; attempt++) {
      await picker.locator.click({ timeout: 5000 });
      try {
        await page.waitForSelector(MODEL_ITEM_SELECTOR, { state: 'attached', timeout: 3500 });
        // The items exist a moment before their text is rendered.
        for (let i = 0; i < 12; i++) {
          const raw = await page.evaluate(collectModelMenu);
          if (raw.some((it) => it.text)) return raw;
          await sleep(250);
        }
      } catch {
        // items never showed up: close and retry
      }
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(1000);
    }
    return null;
  }

  /** The web model catalogue from the picker menu, or null when the picker is not found. */
  async readModels(page) {
    const raw = await this.#openModelMenu(page);
    await page.keyboard.press('Escape').catch(() => {});
    return raw ? parseModelItems(raw) : null;
  }

  /** Picks the model whose menu label (or id) matches `wanted`. */
  async selectModel(page, wanted) {
    const raw = await this.#openModelMenu(page);
    if (!raw) throw new UiError('upstream_protocol_changed', 'model picker not found');
    const found = findModel(parseModelItems(raw), wanted);
    if (!found.model) {
      await page.keyboard.press('Escape').catch(() => {});
      throw new UiError('model_not_found', `no model matches "${String(wanted).slice(0, 60)}" (${found.error})`);
    }
    if (!found.model.enabled) {
      await page.keyboard.press('Escape').catch(() => {});
      throw new UiError('no_valid_account', `model "${found.model.label}" is not available to this account`);
    }
    await page.locator(MODEL_ITEM_SELECTOR).nth(found.model.index).click({ timeout: 5000 });
    // The button shows the short name ("Flash-Lite" for "3.5 Flash-Lite").
    const want = found.model.label.toLowerCase();
    for (let i = 0; i < 12; i++) {
      const shown = (await this.pickerLabel(page)).toLowerCase();
      if (shown && (want.includes(shown) || shown.includes(want))) return found.model;
      await sleep(350);
    }
    throw new UiError('upstream_protocol_changed', `model picker did not switch to "${found.model.label}"`);
  }

  /**
   * Attaches files through the "Upload & tools" menu. files: [{ name, mime, data: Buffer }].
   * Signed-in accounts only (the upload entries are disabled for anonymous visitors).
   */
  async attach(page, files) {
    const payload = files.map((f) => ({ name: f.name, mimeType: f.mime || 'application/octet-stream', buffer: f.data }));
    const menu = await waitForFirst(page, UPLOAD_MENU_SELECTORS, 5000);
    if (!menu) throw new UiError('upstream_protocol_changed', 'upload menu not found');
    await menu.locator.click({ timeout: 5000 });
    const uploader = page.locator(UPLOADER_SELECTOR).first();
    try {
      await uploader.waitFor({ state: 'attached', timeout: 5000 });
    } catch {
      throw new UiError('upstream_protocol_changed', 'upload entry not found');
    }
    if ((await uploader.getAttribute('aria-disabled')) === 'true') {
      throw new UiError('no_valid_account', 'file upload is disabled (not signed in)');
    }
    let chooser = null;
    try {
      [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 8000 }), uploader.click({ timeout: 5000, force: true })]);
    } catch {
      // some builds only expose the hidden <input type=file>
    }
    if (chooser) {
      await chooser.setFiles(payload);
    } else {
      const input = page.locator('input[type="file"]').first();
      if ((await input.count()) === 0) throw new UiError('upstream_protocol_changed', 'file chooser / file input not found');
      await input.setInputFiles(payload);
    }
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(1000);
    this.log('files_attached', { count: files.length, bytes: files.reduce((n, f) => n + f.data.length, 0) });
  }

  async #state(page) {
    return page.evaluate(readChatState, { answer: this.book.list('answer'), stop: this.book.list('stop') });
  }

  async #clickSend(page, input, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (this.book.list('send').length && Date.now() < deadline) {
      for (const selector of this.book.list('send')) {
        try {
          const btn = page.locator(selector).first();
          if ((await btn.count()) > 0 && (await btn.isVisible()) && (await btn.isEnabled())) {
            await btn.click({ timeout: 3000 });
            return selector;
          }
        } catch {
          // try the next one
        }
      }
      await sleep(300);
    }
    await input.press('Enter');
    return 'Enter';
  }

  /** True once the page shows a running generation, a new answer or a conversation URL. */
  async #waitStarted(page, answersBefore, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const st = await this.#state(page).catch(() => null);
      if (st && (st.stop || st.count > answersBefore)) return true;
      if (CONVERSATION_PATH_RE.test(new URL(page.url()).pathname)) return true;
      await sleep(300);
    }
    return false;
  }

  /** Types `text` into the prompt box and sends it. `sendWaitMs`: how long to wait for an enabled send button. */
  async submit(page, text, { sendWaitMs = 6000 } = {}) {
    const input = await this.#findInput(page);
    await input.locator.click({ timeout: 5000 }).catch(() => {});
    await input.locator.fill(text);
    const before = (await this.#state(page)).count;
    const via = await this.#clickSend(page, input.locator, sendWaitMs);
    if (await this.#waitStarted(page, before, 15000)) return via;

    this.log('selectors_failed', { kind: 'send' });
    if (!this.aiKey) throw new UiError('upstream_protocol_changed', 'sending the prompt started nothing and there is no AI fallback key', await pageDiagnostic(page));
    const proposal = await this.#propose(page, 'input');
    if (!proposal.send_selector) throw new UiError('upstream_protocol_changed', 'AI proposal has no send selector', await pageDiagnostic(page));
    try {
      await page.locator(proposal.send_selector).first().click({ timeout: 4000 });
    } catch {
      throw new UiError('upstream_protocol_changed', 'AI-proposed send selector could not be clicked', await pageDiagnostic(page));
    }
    if (!(await this.#waitStarted(page, before, 15000))) {
      throw new UiError('upstream_protocol_changed', 'AI-proposed send selector started nothing', await pageDiagnostic(page));
    }
    this.#learn('send', proposal.send_selector);
    return proposal.send_selector;
  }

  /**
   * Waits until the answer is finished: no stop button, the answer text unchanged for
   * `timing.stable` (1.2 s) and not marked busy. Only `ceilingMs` bounds the wait. Returns
   * { text, code_blocks }; throws UiError.
   */
  async awaitAnswer(page, { ceilingMs = DEFAULT_CEILING_MS } = {}) {
    const t = this.timing;
    const started = Date.now();
    const deadline = started + ceilingMs;
    let flags = '';
    let beat = started;
    let last = '';
    let stableSince = 0;
    let noAnswerSince = 0;
    let aiTried = false;
    let aiAnswer = null; // the AI-proposed answer selector awaiting its first match
    while (Date.now() < deadline) {
      for (const alert of await page.evaluate(collectAlerts).catch(() => [])) {
        const kind = classifyUiMessage(alert, 'alert');
        if (kind) throw uiMessageError(kind, 'alert');
      }
      const st = await this.#state(page);
      const now = Date.now();
      // Trace of the wait: on every change of the flags and every 30 s (lengths only, never text).
      const f = `${+st.stop}${+st.busy}${+st.found}`;
      if (f !== flags || now - beat > 30000) {
        flags = f;
        beat = now;
        this.log('answer_state', { stop: st.stop, busy: st.busy, found: st.found, chars: st.text.length, after_ms: now - started });
      }

      if (!st.found && !st.stop) {
        noAnswerSince ||= now;
        const waited = now - noAnswerSince;
        if (aiAnswer && waited > t.aiVerify) {
          this.book.forget('answer', aiAnswer);
          throw new UiError('upstream_protocol_changed', 'AI-proposed answer selector matched nothing', await pageDiagnostic(page));
        }
        if (!aiTried && waited > t.aiAfter) {
          aiTried = true;
          this.log('selectors_failed', { kind: 'answer' });
          if (this.aiKey) {
            const proposal = await this.#propose(page, 'answer');
            this.#learn('answer', proposal.answer_selector);
            if (proposal.stop_selector) this.#learn('stop', proposal.stop_selector);
            aiAnswer = proposal.answer_selector;
            noAnswerSince = Date.now();
          }
        }
        if (!aiAnswer && waited > t.giveUpAfter) {
          throw new UiError('upstream_protocol_changed', 'answer container not found', await pageDiagnostic(page));
        }
        await sleep(t.poll);
        continue;
      }
      noAnswerSince = 0;
      aiAnswer = null;

      if (!st.stop && st.found && !st.busy && st.text) {
        if (st.text === last) {
          stableSince ||= now;
          if (now - stableSince >= t.stable) {
            const kind = classifyUiMessage(st.text, 'answer');
            if (kind) throw uiMessageError(kind, 'answer text');
            return { text: st.text, code_blocks: st.code_blocks };
          }
        } else {
          last = st.text;
          stableSince = 0;
        }
      } else {
        stableSince = 0;
        last = st.text;
      }
      await sleep(t.poll);
    }
    throw new UiError('upstream_unavailable', `no finished answer within ${Math.round(ceilingMs / 1000)} s`);
  }

  /**
   * Full browser-transport request on a fresh chat.
   * req: { prompt, modelLabel, attachments: [{ name, mime, data: Buffer }], json, ceilingMs }
   * Returns { text, model_label_seen, json_valid? }.
   */
  async ask({ prompt, modelLabel, attachments = [], json = false, ceilingMs }) {
    const page = await this.openChat();
    try {
      if (modelLabel) await this.selectModel(page, modelLabel);
      const files = [...attachments];
      let typed = prompt;
      if (Buffer.byteLength(prompt) > ATTACH_THRESHOLD_BYTES) {
        files.push({ name: 'prompt.txt', mime: 'text/plain', data: Buffer.from(prompt, 'utf8') });
        typed = ATTACHED_PROMPT_INSTRUCTION;
      }
      if (files.length) await this.attach(page, files);
      await this.submit(page, typed, { sendWaitMs: files.length ? 120000 : 6000 });
      const answer = await this.awaitAnswer(page, { ceilingMs });
      const out = { model_label_seen: await this.pickerLabel(page) };
      if (json) Object.assign(out, pickJsonText(answer.text, answer.code_blocks));
      else out.text = answer.text;
      return out;
    } finally {
      await page.close().catch(() => {});
    }
  }
}

function trimOutline(outline, maxBytes = 30 * 1024) {
  let elements = outline.elements;
  const size = (e) => Buffer.byteLength(JSON.stringify({ ...outline, elements: e }));
  while (elements.length > 0 && size(elements) > maxBytes) elements = elements.slice(0, Math.floor(elements.length * 0.9));
  return { ...outline, elements };
}
