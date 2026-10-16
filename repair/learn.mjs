// Drives headless Chromium through one canary chat on gemini.google.com, captures
// the StreamGenerate request/response and turns it into a "learned protocol".

import { chromium } from 'playwright-core';
import {
  assertNoSecrets,
  buildLearned,
  findPromptPath,
  formAt,
  isStreamGenerateUrl,
  parseFReq,
} from './protocol.mjs';
import { collectPageSummary, proposeSelectors, trimSummary } from './ai.mjs';

export const DEFAULT_PROMPT = 'Reply with exactly one word: pong';
const APP_URL = 'https://gemini.google.com/app';
const CONVERSATION_PATH_RE = /^\/app\/[0-9a-f]{8,}$/i;
const TELEMETRY_RE = /google-analytics|googletagmanager|doubleclick|googleadservices|\/log$|\/g\/collect|\/pagead\/|\/measurement\//;

// Ordered, most specific first. Role/aria/contenteditable based; no generated class names
// except the long-lived Quill editor class.
export const INPUT_SELECTORS = [
  'rich-textarea div.ql-editor[contenteditable="true"]',
  'div.ql-editor[contenteditable="true"]',
  '[role="textbox"][contenteditable="true"]',
  'div[contenteditable="true"][aria-label*="prompt" i]',
  'div[contenteditable="true"][aria-label*="message" i]',
  'textarea[aria-label*="prompt" i]',
  'textarea',
  '[contenteditable="true"]',
];
export const SEND_SELECTORS = [
  'button[aria-label*="send message" i]',
  'button[aria-label="Send"]',
  'button.send-button',
  'button[aria-label*="send" i]:not([aria-label*="feedback" i])',
];

// Privacy first: reject non-essential cookies, never accept terms/agreements.
const REJECT_RE =
  /^(reject all|reject|decline all|deny all|alle ablehnen|tout refuser|rechazar todo|rifiuta tutto|t[üu]m[üu]n[üu] reddet|hamısını rədd et|отклонить все|odrzuć wszystko)\b/i;
const DISMISS_RE = /^(no thanks|not now|maybe later|dismiss|skip|close)$/i;

export class LearnError extends Error {
  constructor(code, message, diagnostic) {
    super(message);
    this.code = code;
    this.diagnostic = diagnostic;
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

async function clickSend(page, input, selectors, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (selectors.length && Date.now() < deadline) {
    for (const selector of selectors) {
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

/**
 * Learns the current StreamGenerate protocol.
 * opts: { cookies, prompt, expect, aiKey, aiModel, timeoutMs, log, chromiumPath, noSandbox, fetchImpl }
 * Returns the learned-protocol object; throws LearnError.
 */
export async function learn(opts = {}) {
  const {
    cookies = [],
    prompt = DEFAULT_PROMPT,
    expect = 'pong',
    aiKey = '',
    aiModel,
    timeoutMs = 120000,
    log = () => {},
    chromiumPath,
    noSandbox = false,
    fetchImpl,
  } = opts;

  const pwCookies = toPlaywrightCookies(cookies);
  const secrets = cookies.map((c) => c?.value).filter(Boolean);
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath || undefined,
    args: ['--disable-dev-shm-usage', ...(noSandbox ? ['--no-sandbox'] : [])],
  });
  const overall = setTimeout(() => browser.close().catch(() => {}), timeoutMs);
  try {
    const userAgent = buildUserAgent(browser.version());
    const context = await browser.newContext({
      userAgent,
      locale: 'en-US',
      viewport: { width: 1366, height: 900 },
    });
    if (pwCookies.length) await context.addCookies(pwCookies);
    const page = await context.newPage();

    // --- capture ---------------------------------------------------------
    const capture = {};
    let seenRequest;
    let seenResponse;
    const requestSeen = new Promise((r) => (seenRequest = r));
    const responseSeen = new Promise((r) => (seenResponse = r));
    // Non-telemetry POST endpoints seen after the prompt was typed. They tell "Google
    // moved the chat to another transport" apart from "the UI selectors broke".
    const postEndpoints = new Set();
    let typed = false;
    page.on('request', (req) => {
      if (!typed || req.method() !== 'POST' || isStreamGenerateUrl(req.url())) return;
      const u = new URL(req.url());
      if (TELEMETRY_RE.test(u.host + u.pathname)) return;
      postEndpoints.add(`${u.host}${u.pathname}`);
    });
    page.on('request', (req) => {
      if (capture.url || req.method() !== 'POST' || !isStreamGenerateUrl(req.url())) return;
      const body = req.postData() ?? '';
      try {
        if (!findPromptPath(parseFReq(body).inner, prompt)) return;
      } catch {
        return;
      }
      // headers() never contains cookies; filterHeaders() narrows it further.
      Object.assign(capture, { url: req.url(), headers: req.headers(), body, request: req, at: formAt(body) });
      seenRequest();
    });
    page.on('response', async (res) => {
      if (!capture.request || res.request() !== capture.request) return;
      capture.status = res.status();
      capture.raw = await res.text().catch(() => '');
      seenResponse();
    });

    // --- navigation ------------------------------------------------------
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    log('page_loaded', { path: new URL(page.url()).pathname });

    // --- UI: default selectors, then the AI fallback ----------------------
    const attempt = async (selectors, inputTimeout) => {
      const input = await waitForFirst(page, selectors.input, inputTimeout);
      if (!input) return { ok: false, reason: 'no_input' };
      await input.locator.click({ timeout: 5000 }).catch(() => {});
      await input.locator.fill(prompt);
      typed = true;
      const send = await clickSend(page, input.locator, selectors.send);
      const seen = await Promise.race([requestSeen.then(() => true), sleep(15000).then(() => false)]);
      return seen ? { ok: true, input: input.selector, send } : { ok: false, reason: 'no_request' };
    };

    let ui = { method: 'selectors', ai_proposal: undefined };
    let result = await attempt({ input: INPUT_SELECTORS, send: SEND_SELECTORS }, 20000);
    // A conversation URL (/app/<id>) without a StreamGenerate call: the chat worked over another transport.
    if (!result.ok && result.reason === 'no_request' && CONVERSATION_PATH_RE.test(new URL(page.url()).pathname)) {
      throw new LearnError('transport_changed', 'the chat started but not through StreamGenerate', {
        ...(await pageDiagnostic(page)),
        post_endpoints_after_send: [...postEndpoints],
      });
    }
    if (!result.ok) {
      log('selectors_failed', { reason: result.reason });
      if (!aiKey) {
        throw new LearnError(result.reason, `default selectors failed (${result.reason}); no GEMINI_REPAIR_API_KEY for the AI fallback`, await pageDiagnostic(page));
      }
      const summary = trimSummary(await page.evaluate(collectPageSummary));
      let proposal;
      try {
        proposal = await proposeSelectors(summary, { apiKey: aiKey, model: aiModel, fetchImpl });
      } catch (e) {
        throw new LearnError('ai_failed', `AI selector proposal failed: ${e.message}`, await pageDiagnostic(page));
      }
      log('ai_proposal', { input: proposal.input_selector, send: proposal.send_selector });
      result = await attempt({ input: [proposal.input_selector], send: proposal.send_selector ? [proposal.send_selector] : [] }, 10000);
      if (!result.ok) {
        throw new LearnError(result.reason, `AI-proposed selectors failed (${result.reason})`, await pageDiagnostic(page));
      }
      ui = { method: 'ai-selectors', ai_proposal: proposal };
    }
    ui = { ...ui, input: result.input, send: result.send };
    log('request_captured', { ui_method: ui.method });

    const done = await Promise.race([responseSeen.then(() => true), sleep(60000).then(() => false)]);
    if (!done) throw new LearnError('no_response', 'StreamGenerate response did not finish in 60 s', await pageDiagnostic(page));

    const learned = buildLearned({
      capture,
      prompt,
      expect,
      ui,
      userAgent,
      anonymous: pwCookies.length === 0,
    });
    assertNoSecrets(learned, [...secrets, capture.at]);
    log('learned', { bl: learned.bl, response_ok: learned.response_ok, http_status: capture.status });
    return learned;
  } finally {
    clearTimeout(overall);
    await browser.close().catch(() => {});
  }
}
