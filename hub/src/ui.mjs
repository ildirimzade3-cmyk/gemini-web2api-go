// Driving gemini.google.com the way a person does: open a new (temporary) chat,
// pick the model in the picker and confirm it took, paste the message, press send,
// wait for the answer, press "Copy" and take Google's own markdown.
//
// Every step reports whether the prompt has reached Google yet (`sent`), because a
// prompt that was sent is never sent again by the hub.

import { collectAccountFacts, collectAlerts, collectModelMenu, readChatState } from './page.mjs';
import { collectAnswerOutline, collectPageSummary, proposeAnswerSelectors, proposeSelectors, trimSummary } from './repair-ai.mjs';
import { parseResetTime, tzOffsetMs } from './policy.mjs';

// hl=en: every account's UI in English whatever its Google language, so one set of
// labels and selectors fits all accounts.
export const APP_URL = 'https://gemini.google.com/app?hl=en';
export const USAGE_URL = 'https://gemini.google.com/usage?hl=en';
/** Prompts above this size are attached as message.txt instead of being pasted. */
export const ATTACH_THRESHOLD_BYTES = 30 * 1024;
export const ATTACHED_PROMPT_INSTRUCTION =
  'My complete message is in the attached file message.txt. Read it and respond to it exactly as if I had written it here.';

export const DEFAULT_SELECTORS = Object.freeze({
  input: ['rich-textarea div.ql-editor[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]', '[role="textbox"][contenteditable="true"]'],
  send: ['button[aria-label*="send message" i]', 'button.send-button', 'button[aria-label="Send"]'],
  stop: ['button[aria-label="Stop response"]', 'button[aria-label*="stop response" i]', 'button[aria-label*="stop generating" i]', 'button[aria-label^="Stop" i]', 'button.send-button.stop'],
  answer: ['model-response message-content', 'model-response .markdown'],
  userTurn: ['user-query', '[data-test-id="user-query"]'],
  copy: ['message-actions button[aria-label="Copy"]', 'message-actions button[aria-label^="Copy" i]', 'button[data-test-id="copy-button"]'],
  picker: ['button[data-test-id="bard-mode-menu-button"]', 'button[aria-label^="Open mode picker" i]'],
  pickerItem: ['[data-test-id^="bard-mode-option-"]'],
  newChat: ['button[aria-label="New chat"]', 'a[aria-label="New chat"]', '[data-test-id="new-chat-button"] button', '[data-test-id="new-chat-button"]'],
  tempChat: ['button[aria-label*="temporary chat" i]', '[data-test-id*="temp-chat" i] button', '[data-test-id*="temp-chat" i]'],
  uploadMenu: ['button[aria-label="Upload & tools"]', 'button[aria-label*="upload" i]'],
  uploader: ['[data-test-id="local-images-files-uploader-button"]', '[data-test-id="hidden-local-file-upload-button"]'],
});

export class UiError extends Error {
  /** code: ui_changed | signed_out | challenge | throttled | limit | model_unavailable | model_changed | generation_failed | browser_error */
  constructor(code, message, { sent = false, resetAt = null, role = null, diag = null } = {}) {
    super(message);
    Object.assign(this, { code, sent, resetAt, role, diag });
  }
}

// --- message classification (alerts, short answers, page headings) -----------

const RE_CHALLENGE = /unusual (traffic|activity)|verify (it'?s|that it'?s) you|confirm (it'?s|that it'?s|you'?re) you|captcha|not a robot|suspicious activity|account (has been )?(disabled|suspended|restricted)/i;
const RE_SIGNED_OUT = /sign in to (continue|use|try)|you(?:'ve| have) been signed out|session (has )?expired|please sign in/i;
const RE_LIMIT = /(reached|hit) (your|the) [\w\s.-]{0,40}limit|usage limit|limit (reached|resets?)|try again (later|tomorrow|in \d)|too many requests|exceeded (your|the) [\w\s]{0,30}(limit|quota)|out of [\w\s]{0,20}(prompts|messages|uses)/i;
const RE_MODEL_SWITCH = /(switch(ed|ing)?|fall(ing|en)? back|downgrad\w*|moved) (you |your chat |this chat )?to\b|responses? (will|now) (use|come from)|now using/i;
const RE_FAILURE = /^(sorry,? )?(something went wrong|there was an error|an error occurred|i('m| am) having trouble)/i;

/** "challenge" | "signed_out" | "limit" | "model_switch" | "failure" | null */
export function classifyMessage(text, source = 'alert') {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (source === 'answer' && t.length > 400) return null;
  if (RE_CHALLENGE.test(t)) return 'challenge';
  if (RE_SIGNED_OUT.test(t)) return 'signed_out';
  if (RE_LIMIT.test(t)) return 'limit';
  if (RE_MODEL_SWITCH.test(t) && /\b(flash|pro|model|lite|thinking)\b/i.test(t)) return 'model_switch';
  if (RE_FAILURE.test(t)) return 'failure';
  return null;
}

function errorFor(kind, text, { sent, tz }) {
  const snippet = String(text).slice(0, 160);
  switch (kind) {
    case 'challenge':
      return new UiError('challenge', `Google asks for a check: "${snippet}"`, { sent });
    case 'signed_out':
      return new UiError('signed_out', `the account is signed out: "${snippet}"`, { sent });
    case 'limit':
      return new UiError('limit', `Gemini reports a limit: "${snippet}"`, { sent, resetAt: parseResetTime(text, Date.now(), tz) });
    case 'model_switch':
      return new UiError('model_changed', `Gemini switched the model: "${snippet}"`, { sent });
    default:
      return new UiError('generation_failed', `Gemini reported a failure: "${snippet}"`, { sent });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const human = (lo, hi) => sleep(lo + Math.random() * (hi - lo));
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Ordered selectors per role: learned ones first, then the defaults. */
export class SelectorBook {
  constructor(learned = {}, onChange = () => {}) {
    this.learned = structuredClone(learned);
    this.onChange = onChange;
  }
  list(role) {
    const l = this.learned[role] ?? [];
    return [...l, ...(DEFAULT_SELECTORS[role] ?? []).filter((s) => !l.includes(s))];
  }
  learn(role, selector) {
    if (!selector || this.learned[role]?.[0] === selector) return;
    this.learned[role] = [selector, ...(this.learned[role] ?? []).filter((s) => s !== selector)].slice(0, 3);
    this.onChange(this.learned);
  }
}

export class GeminiPage {
  /** opts: { book, log, repairKey, repairModel, tz } */
  constructor(page, opts) {
    this.page = page;
    this.book = opts.book;
    this.log = opts.log ?? (() => {});
    this.repairKey = opts.repairKey || '';
    this.repairModel = opts.repairModel;
    this.tz = opts.tz || 'UTC';
  }

  async #first(role, { timeout = 0, visible = true } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      for (const sel of this.book.list(role)) {
        try {
          const loc = this.page.locator(sel);
          const n = Math.min(await loc.count(), 6);
          for (let i = n - 1; i >= 0; i--) {
            const el = loc.nth(i);
            if (!visible || (await el.isVisible())) return { sel, el };
          }
        } catch {
          // invalid learned selector: skip
        }
      }
      if (Date.now() >= deadline) return null;
      await sleep(250);
    }
  }

  async #checkPage(sent) {
    const u = new URL(this.page.url());
    if (u.pathname.startsWith('/sorry')) throw new UiError('challenge', 'Google served its "unusual traffic" page', { sent });
    if (u.host === 'accounts.google.com') {
      const t = await this.page.title().catch(() => '');
      throw new UiError(/verify|challenge|confirm/i.test(t) ? 'challenge' : 'signed_out', `Google redirected to accounts.google.com (${t.slice(0, 60)})`, { sent });
    }
  }

  async #scanAlerts(sent) {
    for (const text of await this.page.evaluate(collectAlerts).catch(() => [])) {
      const kind = classifyMessage(text, 'alert');
      if (kind && kind !== 'failure') throw errorFor(kind, text, { sent, tz: this.tz });
      if (kind === 'failure' && sent) throw errorFor(kind, text, { sent, tz: this.tz });
    }
  }

  /** Loads the app (when not already on it) and waits for the prompt box. */
  async open() {
    const lang = await this.page.evaluate(() => document.documentElement.lang || '').catch(() => '');
    if (!/^https:\/\/gemini\.google\.com\/app/.test(this.page.url()) || !/^en/i.test(lang)) {
      let res;
      try {
        res = await this.page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      } catch (e) {
        throw new UiError('browser_error', `loading Gemini failed: ${e.message.split('\n')[0]}`);
      }
      const status = res?.status() ?? 0;
      if (status === 429) throw new UiError('throttled', 'gemini.google.com answered HTTP 429 (too many requests)');
      if (status >= 500) throw new UiError('browser_error', `gemini.google.com answered HTTP ${status}`);
    }
    await this.#checkPage(false);
    await this.#input();
  }

  async #input() {
    const found = await this.#first('input', { timeout: 25_000 });
    if (found) return found.el;
    await this.#checkPage(false);
    await this.#scanAlerts(false);
    if (this.repairKey) {
      const proposal = await this.#propose('input');
      const el = this.page.locator(proposal.input_selector).first();
      if (await el.isVisible().catch(() => false)) {
        this.book.learn('input', proposal.input_selector);
        if (proposal.send_selector) this.book.learn('send', proposal.send_selector);
        this.log('selector_learned', { role: 'input' });
        return el;
      }
    }
    throw new UiError('ui_changed', 'prompt box not found', { role: 'input' });
  }

  async #propose(kind) {
    const opts = { apiKey: this.repairKey, model: this.repairModel };
    try {
      if (kind === 'answer') return await proposeAnswerSelectors(await this.page.evaluate(collectAnswerOutline), opts);
      return await proposeSelectors(trimSummary(await this.page.evaluate(collectPageSummary)), opts);
    } catch (e) {
      throw new UiError('ui_changed', `AI selector proposal failed: ${e.message}`, { role: kind });
    }
  }

  /** { signed_in, identity, plan, plan_label } */
  async accountFacts() {
    const [facts, source] = await Promise.all([this.page.evaluate(collectAccountFacts), this.page.content()]);
    const xsrf = /"SNlM0e"\s*:\s*"[^"]{8,}"/.test(source);
    // The XSRF token is only issued to a signed-in session; no "Sign in" button either.
    const signed_in = xsrf && !facts.sign_in_visible;
    const plan = !signed_in ? 'unknown' : facts.plan_badge ? 'paid' : facts.upgrade_hint ? 'free' : 'unknown';
    return { signed_in, identity: facts.identity, plan, plan_label: facts.plan_badge || facts.upgrade_hint || '' };
  }

  /**
   * Starts a new chat. A page without turns is used as it is; otherwise the "New
   * chat" button (what a person clicks), and a reload of /app only when that fails.
   */
  async newChat() {
    await this.open();
    const turns = async () => (await this.#counts().catch(() => ({ answer: 1 }))).answer;
    if ((await turns()) === 0 && !/^\/app\/[0-9a-f]{6,}/i.test(new URL(this.page.url()).pathname)) return;
    const btn = await this.#first('newChat', { timeout: 1500 });
    if (btn) {
      await btn.el.click({ timeout: 5000 }).catch(() => {});
      for (let i = 0; i < 16; i++) {
        await sleep(200);
        if ((await turns()) === 0 && (await this.#first('input'))) return;
      }
    }
    await this.page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await this.open();
  }

  /** Switches the fresh chat to a temporary chat when the account offers it. Returns true when on. */
  async temporaryChat() {
    // An account without the switch is not searched again for an hour (saves 1.5 s per prompt).
    if (this.noTempUntil > Date.now()) return false;
    const found = await this.#first('tempChat', { timeout: 1500 });
    if (!found) {
      this.noTempUntil = Date.now() + 3_600_000;
      return false;
    }
    const pressed = async () => {
      const a = await found.el.getAttribute('aria-pressed').catch(() => null);
      if (a !== null) return a === 'true';
      return /temporary chat/i.test(await this.page.locator('body').innerText().catch(() => ''));
    };
    if (await pressed()) return true;
    await found.el.click({ timeout: 5000 }).catch(() => {});
    for (let i = 0; i < 12; i++) {
      await sleep(250);
      if (await pressed()) return true;
    }
    return false;
  }

  async #openPicker() {
    const picker = await this.#first('picker', { timeout: 12_000 });
    if (!picker) throw new UiError('ui_changed', 'model picker not found', { role: 'picker' });
    for (let attempt = 0; attempt < 3; attempt++) {
      await picker.el.click({ timeout: 5000 }).catch(() => {});
      for (let i = 0; i < 16; i++) {
        await sleep(250);
        const items = await this.page.evaluate(collectModelMenu).catch(() => []);
        if (items.some((it) => it.text)) return items;
      }
      await this.page.keyboard.press('Escape').catch(() => {});
      await sleep(800);
    }
    throw new UiError('ui_changed', 'model picker opened no items', { role: 'pickerItem' });
  }

  /** The model catalogue: [{ label, description, id, enabled, selected, index }]. */
  async models() {
    const raw = await this.#openPicker();
    await this.page.keyboard.press('Escape').catch(() => {});
    return parseModelItems(raw);
  }

  /** Label on the picker button right now ("3.1 Pro"), or "". */
  async currentModel() {
    const picker = await this.#first('picker', { timeout: 3000 });
    if (!picker) return '';
    const aria = (await picker.el.getAttribute('aria-label').catch(() => '')) || '';
    return /currently\s+(.+)$/i.exec(aria.trim())?.[1]?.trim() ?? norm(await picker.el.innerText().catch(() => ''));
  }

  /** Picks the model with exactly this label and confirms the picker shows it. */
  async selectModel(label) {
    // Already set (the usual case for consecutive prompts): no need to open the picker.
    if (this.catalogueLabels && (await this.verifyModel(label)).ok) return;
    const items = parseModelItems(await this.#openPicker());
    const target = items.find((m) => norm(m.label).toLowerCase() === norm(label).toLowerCase());
    if (!target) {
      await this.page.keyboard.press('Escape').catch(() => {});
      throw new UiError('model_unavailable', `the model picker has no "${label}"`);
    }
    if (!target.enabled) {
      await this.page.keyboard.press('Escape').catch(() => {});
      const kind = classifyMessage(target.description) === 'limit' || /limit|available|resets?/i.test(target.description) ? 'limit' : 'model_unavailable';
      throw new UiError(kind, `"${label}" is not selectable now (${target.description.slice(0, 120)})`, {
        resetAt: kind === 'limit' ? parseResetTime(target.description, Date.now(), this.tz) : null,
      });
    }
    await human(200, 500);
    await this.page.locator(this.book.list('pickerItem').join(', ')).nth(target.index).click({ timeout: 5000 });
    for (let i = 0; i < 16; i++) {
      await sleep(250);
      if (labelsMatch(await this.currentModel(), label)) {
        this.catalogueLabels = items.map((m) => m.label);
        return;
      }
    }
    throw new UiError('ui_changed', `the picker did not switch to "${label}"`, { role: 'picker' });
  }

  /**
   * Sets the model's thinking level ("low" | "medium" | "high") in the model menu's
   * "Thinking level" submenu and confirms the check mark moved there. Returns the
   * level, or "n/a" when the account/model has no such submenu (e.g. Auto).
   */
  async setThinking(level) {
    const want = { low: 'Low', medium: 'Medium', high: 'High' }[level];
    if (!want) throw new UiError('ui_changed', `unknown thinking level ${level}`);
    const openSub = async () => {
      await this.#openPicker();
      const trigger = this.page.locator('gem-menu-item[value="thinking_level"]').first();
      if (!(await trigger.count())) return null;
      await trigger.hover().catch(() => {});
      await trigger.click({ timeout: 5000 }).catch(() => {});
      const item = this.page.locator('gem-menu-item').filter({ has: this.page.locator('span.label', { hasText: new RegExp(`^\\s*${want}\\s*$`) }) }).first();
      await item.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      return (await item.count()) ? item : null;
    };
    const close = async () => {
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.keyboard.press('Escape').catch(() => {});
    };
    const selected = async (item) => /\bselected\b/.test((await item.getAttribute('class').catch(() => '')) || '');
    let item = await openSub();
    if (!item) {
      await close();
      return 'n/a';
    }
    if (await selected(item)) {
      await close();
      return level;
    }
    await human(150, 400);
    await item.click({ timeout: 5000 });
    await sleep(500);
    await close();
    item = await openSub();
    const ok = item && (await selected(item));
    await close();
    if (!ok) throw new UiError('ui_changed', `the thinking level did not switch to ${want}`, { role: 'picker' });
    return level;
  }

  /**
   * True when the chat is set to exactly `label`. The picker button often shows a
   * short name ("Flash"); when that short name fits more than one catalogue entry,
   * the open menu's checked item decides.
   */
  async verifyModel(label) {
    const shown = await this.currentModel();
    if (!labelsMatch(shown, label)) return { ok: false, shown };
    const fits = (this.catalogueLabels ?? [label]).filter((l) => labelsMatch(shown, l));
    if (fits.length <= 1) return { ok: true, shown };
    const items = parseModelItems(await this.#openPicker());
    await this.page.keyboard.press('Escape').catch(() => {});
    const sel = items.find((m) => m.selected);
    return { ok: Boolean(sel) && norm(sel.label).toLowerCase() === norm(label).toLowerCase(), shown: sel?.label ?? shown };
  }

  async attach(files) {
    const menu = await this.#first('uploadMenu', { timeout: 5000 });
    if (!menu) throw new UiError('ui_changed', 'upload menu not found', { role: 'uploadMenu' });
    await menu.el.click({ timeout: 5000 });
    await human(300, 700);
    const up = await this.#first('uploader', { timeout: 5000, visible: false });
    if (!up) throw new UiError('ui_changed', 'upload entry not found', { role: 'uploader' });
    if ((await up.el.getAttribute('aria-disabled')) === 'true') throw new UiError('signed_out', 'file upload is disabled (not signed in)');
    const payload = files.map((f) => ({ name: f.name, mimeType: f.mime, buffer: f.data }));
    let chooser = null;
    try {
      [chooser] = await Promise.all([this.page.waitForEvent('filechooser', { timeout: 8000 }), up.el.click({ timeout: 5000, force: true })]);
    } catch {
      // some builds only expose the hidden <input type=file>
    }
    if (chooser) await chooser.setFiles(payload);
    else {
      const input = this.page.locator('input[type="file"]').first();
      if (!(await input.count())) throw new UiError('ui_changed', 'file input not found', { role: 'uploader' });
      await input.setInputFiles(payload);
    }
    await this.page.keyboard.press('Escape').catch(() => {});
    await human(800, 1400);
  }

  /** Pastes the message into the prompt box and checks the box holds exactly that text. */
  async insert(text) {
    const box = await this.#input();
    await box.click({ timeout: 5000 });
    for (let attempt = 0; attempt < 2; attempt++) {
      await box.evaluate((el, t) => {
        el.focus();
        const sel = window.getSelection();
        sel.removeAllRanges();
        const r = document.createRange();
        r.selectNodeContents(el);
        sel.addRange(r);
        document.execCommand('delete', false);
        document.execCommand('insertText', false, t);
      }, text);
      await sleep(150);
      if (norm(await box.innerText().catch(() => '')) === norm(text)) return;
    }
    throw new UiError('ui_changed', 'the prompt box did not take the text exactly', { role: 'input' });
  }

  async #counts() {
    return this.page.evaluate(
      ({ u, a }) => {
        const q = (sels) => {
          for (const s of sels) {
            try {
              const n = document.querySelectorAll(s).length;
              if (n) return n;
            } catch {
              // ignore
            }
          }
          return 0;
        };
        return { user: q(u), answer: q(a) };
      },
      { u: this.book.list('userTurn'), a: this.book.list('answer') },
    );
  }

  async #state() {
    return this.page.evaluate(readChatState, { answer: this.book.list('answer'), stop: this.book.list('stop') });
  }

  /**
   * Presses send and waits for evidence that Gemini accepted the message (a new user
   * turn, a running generation or a new answer). Only when there is positive evidence
   * that nothing was sent (the text is still in the box, no new turn) is send pressed
   * a second time.
   */
  async send({ files = false } = {}) {
    const before = await this.#counts();
    this.responsesBefore = await this.page.evaluate(() => document.querySelectorAll('model-response').length).catch(() => 0);
    for (let attempt = 0; attempt < 2; attempt++) {
      // With files the button stays disabled until the upload finished; without, 8 s is plenty.
      const btn = await this.#first('send', { timeout: attempt ? 2000 : files ? 120_000 : 8000 });
      if (btn && (await btn.el.isEnabled().catch(() => false))) await btn.el.click({ timeout: 5000 });
      else await this.page.keyboard.press('Enter');
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await sleep(250);
        const c = await this.#counts().catch(() => before);
        const st = await this.#state().catch(() => null);
        if (c.user > before.user || c.answer > before.answer || st?.stop) return;
      }
      const box = await this.#first('input', { timeout: 1000 });
      const stillThere = box && norm(await box.el.innerText().catch(() => '')).length > 0;
      if (!stillThere) {
        // The box was emptied but no turn appeared: the message may have gone out.
        throw new UiError('ui_changed', 'sent state unclear (box emptied, no new turn)', { sent: true, role: 'userTurn' });
      }
    }
    throw new UiError('ui_changed', 'pressing send started nothing', { role: 'send' });
  }

  /**
   * Waits for the finished answer. onProgress(text) gets the growing answer text
   * (rendered back to markdown from the page). No time limit: a strong model is
   * never cut short. Returns { text } with Google's own markdown from "Copy".
   */
  async waitAnswer(onProgress = () => {}) {
    let last = '';
    let stableSince = 0;
    let noAnswerSince = Date.now();
    let triedRepair = false;
    for (;;) {
      await this.#checkPage(true);
      await this.#scanAlerts(true);
      const st = await this.#state();
      const now = Date.now();
      // A new model turn without text yet = the model is thinking: keep waiting, however long.
      const thinking = st.responses > (this.responsesBefore ?? 0);
      if (!st.found && !st.stop && thinking) {
        noAnswerSince = now;
        await sleep(400);
        continue;
      }
      if (!st.found && !st.stop) {
        if (now - noAnswerSince > (triedRepair ? 90_000 : 45_000)) {
          if (this.repairKey && !triedRepair) {
            triedRepair = true;
            const p = await this.#propose('answer');
            this.book.learn('answer', p.answer_selector);
            if (p.stop_selector) this.book.learn('stop', p.stop_selector);
            noAnswerSince = now;
            continue;
          }
          throw new UiError('ui_changed', 'answer container not found', { sent: true, role: 'answer' });
        }
        await sleep(300);
        continue;
      }
      noAnswerSince = now;
      if (st.text && st.text !== last) {
        last = st.text;
        stableSince = now;
        onProgress(st.text);
      }
      const settled = !st.stop && !st.busy && st.text && (st.complete ? now - stableSince > 300 : now - stableSince > 1500);
      if (settled) break;
      await sleep(250);
    }
    const kind = classifyMessage(last, 'answer');
    if (kind) throw errorFor(kind, last, { sent: true, tz: this.tz });
    const copied = await this.#copyLast();
    // Google's markdown is the answer; the rendered text is only a cross-check.
    if (copied && norm(copied).length >= norm(last).length * 0.5) return { text: copied.replace(/\n{2,}```$/, '\n```'), via: 'copy' };
    this.log('copy_fallback', { copied: copied.length, rendered: last.length });
    this.onDrift?.('copy', 'the Copy button was not found; the answer was read from the page instead');
    return { text: last, via: 'render' };
  }

  async #copyLast() {
    const found = await this.#first('copy', { timeout: 5000 });
    if (!found) return '';
    await this.page.evaluate(() => navigator.clipboard.writeText('')).catch(() => {});
    await found.el.click({ timeout: 5000 }).catch(() => {});
    for (let i = 0; i < 12; i++) {
      await sleep(200);
      const t = await this.page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
      if (t) return t;
    }
    return '';
  }

  /** Sends a follow-up in the same chat (JSON repair) and returns the new answer. */
  async followUp(text, onProgress) {
    await this.insert(text);
    await this.send();
    return this.waitAnswer(onProgress);
  }

  /**
   * Test hook (only reachable when HUB_CHAOS=1): makes this page look as if Google
   * renamed an element, so the drift detection and selector repair can be proven on
   * the real site. Only our own copy of the page is changed.
   */
  async applyChaos(kind) {
    if (!kind) return;
    await this.page.evaluate((k) => {
      const mutate = () => {
        if (k === 'input') {
          for (const el of document.querySelectorAll('div.ql-editor[contenteditable="true"], [role="textbox"][contenteditable="true"]')) {
            el.classList.remove('ql-editor');
            el.removeAttribute('role');
            el.setAttribute('data-chaos', 'editor');
          }
        }
        if (k === 'copy') for (const b of document.querySelectorAll('message-actions button[aria-label^="Copy" i]')) b.setAttribute('aria-label', 'Duplicate text');
        if (k === 'send') for (const b of document.querySelectorAll('button[aria-label*="send message" i], button.send-button')) {
          b.setAttribute('aria-label', 'Submit');
          b.classList.remove('send-button');
        }
      };
      mutate();
      new MutationObserver(mutate).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-label', 'role'] });
    }, kind);
  }

  /**
   * Gemini's own usage meter (gemini.google.com/usage): what share of the 5-hour
   * allowance and of the weekly limit is used and when each resets. Visits the page
   * the way a person checks it, then returns to the app. Returns { meters, raw }.
   */
  async readUsage() {
    // A second tab, closed afterwards: one page load, and the chat tab is not reloaded.
    const tab = await this.page.context().newPage();
    try {
      const res = await tab.goto(USAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      if (res?.status() === 429) throw new UiError('throttled', 'the usage page answered HTTP 429 (too many requests)');
      let raw = '';
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        raw = await tab.evaluate(() => (document.querySelector('main') || document.body).innerText || '').catch(() => '');
        if (/%/.test(raw)) break;
      }
      await sleep(800 + Math.random() * 1200);
      return { meters: parseUsage(raw, Date.now(), this.tz), raw: raw.slice(0, 4000) };
    } finally {
      await tab.close().catch(() => {});
      await this.page.bringToFront().catch(() => {});
    }
  }

  /** Text-free outline for diagnostics when a step breaks. */
  async diagnostic() {
    try {
      const s = trimSummary(await this.page.evaluate(collectPageSummary), 12 * 1024);
      return { url_path: s.url_path, title: s.title, elements: s.elements.slice(0, 80) };
    } catch {
      return null;
    }
  }
}

export function labelsMatch(shown, label) {
  const a = norm(shown).toLowerCase();
  const b = norm(label).toLowerCase();
  if (!a || !b) return false;
  return a === b || b.endsWith(a) || a.endsWith(b);
}

/** Raw picker items -> catalogue entries (label = first line, description = the rest). */
export function parseModelItems(raw) {
  const out = [];
  const seen = new Set();
  (Array.isArray(raw) ? raw : []).forEach((it, index) => {
    const lines = String(it?.text ?? '')
      .split(/\n+/)
      .map(norm)
      .filter(Boolean);
    const label = lines[0] ?? '';
    if (!label || seen.has(label.toLowerCase())) return;
    seen.add(label.toLowerCase());
    out.push({ index, label, description: lines.slice(1).join(' '), id: it.id || '', enabled: it.enabled !== false, selected: Boolean(it.selected) });
  });
  return out;
}



const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Resets at 10:17 AM" / "Resets Oct 20 at 3:17 AM" / "Resets in 2 hr 10 min" -> epoch ms (page time zone `tz`). */
export function parseResetPhrase(line, now = Date.now(), tz = 'UTC') {
  const s = String(line ?? '');
  const rel = /resets?\s+in\s+(?:(\d+)\s*(?:d|days?)\b)?\s*(?:(\d+)\s*(?:h|hr|hrs|hours?)\b)?\s*(?:(\d+)\s*(?:m|min|mins|minutes?)\b)?/i.exec(s);
  if (rel && (rel[1] || rel[2] || rel[3])) return now + ((+rel[1] || 0) * 1440 + (+rel[2] || 0) * 60 + (+rel[3] || 0)) * 60_000;
  const dated = /resets?\s+(?:on\s+)?([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?\s+at\s+(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i.exec(s);
  if (dated) {
    const mon = MONTHS.indexOf(dated[1].toLowerCase());
    if (mon < 0) return null;
    let hh = Number(dated[4]) % 12;
    if (dated[6].toLowerCase() === 'p') hh += 12;
    const offset = tzOffsetMs(tz, now);
    const localYear = new Date(now + offset).getUTCFullYear();
    let year = dated[3] ? Number(dated[3]) : localYear;
    let t = Date.UTC(year, mon, Number(dated[2]), hh, Number(dated[5])) - offset;
    if (!dated[3] && t < now - 86_400_000) t = Date.UTC(++year, mon, Number(dated[2]), hh, Number(dated[5])) - offset;
    return t;
  }
  return parseResetTime(s, now, tz);
}

/**
 * Meters from the usage page text. The page has one block per window, each
 * starting with its heading ("Current usage" = the rolling 5-hour allowance,
 * "Weekly limit", ...) and holding "NN% used" and a "Resets ..." line in either
 * order. Returns [{ name, used_pct, resets_at }].
 */
export function parseUsage(text, now = Date.now(), tz = 'UTC') {
  const lines = String(text ?? '').split(/\n+/).map(norm).filter(Boolean);
  const HEAD = /^(current usage|5[- ]?hour (?:usage|limit)|weekly (?:usage|limit)|daily (?:usage|limit)|monthly (?:usage|limit))$/i;
  const meters = [];
  for (let i = 0; i < lines.length; i++) {
    if (!HEAD.test(lines[i])) continue;
    const h = lines[i].toLowerCase();
    const name = /current|5/.test(h) ? '5h' : /week/.test(h) ? 'weekly' : /daily/.test(h) ? 'daily' : 'monthly';
    let used = null;
    let resets = null;
    for (let j = i + 1; j < lines.length && j < i + 6 && !HEAD.test(lines[j]); j++) {
      const p = /^(\d{1,3}(?:\.\d+)?)\s*%\s*(used|left|remaining)?/i.exec(lines[j]);
      if (p && used === null) used = /left|remaining/i.test(p[2] ?? '') ? 100 - Number(p[1]) : Number(p[1]);
      if (/^resets?\b/i.test(lines[j]) && resets === null) resets = parseResetPhrase(lines[j], now, tz);
    }
    if (used !== null && !meters.some((m) => m.name === name)) meters.push({ name, used_pct: Math.max(0, Math.min(100, used)), resets_at: resets });
  }
  return meters;
}
