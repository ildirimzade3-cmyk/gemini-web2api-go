// `learn` mode: one headless visit of gemini.google.com/app that collects what the
// bridge's direct protocol needs (build label, XSRF presence, signed-in state, web
// model catalogue) and proves the browser UI itself still works with a canary chat.

import { canaryMatches } from './answer.mjs';
import { toCatalogue } from './facts.mjs';
import { assertNoSecrets } from './secrets.mjs';
import { BrowserSession, UiError } from './session.mjs';

export const DEFAULT_PROMPT = 'Reply with exactly one word: pong';
export const DEFAULT_EXPECT = 'pong';

/**
 * opts: { cookies, prompt, expect, aiKey, aiModel, timeoutMs, log, chromiumPath, noSandbox, fetchImpl }
 * Returns the page-facts document (without account_id); throws UiError when the page
 * itself cannot be read (nothing to report). A failing UI canary is reported as
 * `ui_ok: false` with `ui_error`, not thrown: the facts are still useful.
 */
export async function learn(opts = {}) {
  const {
    cookies = [],
    prompt = DEFAULT_PROMPT,
    expect = DEFAULT_EXPECT,
    aiKey = '',
    aiModel,
    timeoutMs = 120000,
    log = () => {},
    chromiumPath,
    noSandbox = false,
    fetchImpl,
  } = opts;

  const session = new BrowserSession({ cookies, aiKey, aiModel, chromiumPath, noSandbox, fetchImpl, log });
  const startedAt = Date.now();
  // Last resort; the canary wait below ends on its own before this fires.
  const overall = setTimeout(() => session.close(), timeoutMs);
  try {
    await session.start();
    const page = await session.openChat();
    const facts = await session.readFacts(page);
    if (!facts.bl) throw new UiError('upstream_protocol_changed', 'build label (cfb2h) not found in the page');
    log('facts', { bl: facts.bl, xsrf_present: facts.xsrf_present, signed_in: facts.signed_in });

    let models = null;
    try {
      models = await session.readModels(page);
    } catch (e) {
      log('models_failed', { error: e.message.split('\n')[0] });
    }
    log('models', { count: models?.length ?? 0 });
    // The picker button renders after the prompt box, so its label is read once the menu was used.
    const picker_label = (await session.pickerLabel(page)) || facts.picker_label;

    let ui_ok = false;
    let ui_error;
    try {
      await session.submit(page, prompt);
      const left = Math.max(10000, timeoutMs - (Date.now() - startedAt) - 5000);
      const answer = await session.awaitAnswer(page, { ceilingMs: left });
      ui_ok = canaryMatches(answer.text, expect);
      if (!ui_ok) ui_error = 'unexpected_answer';
      log('canary', { ui_ok, answer_chars: answer.text.length });
    } catch (e) {
      ui_error = e.code ?? 'error';
      log('canary_failed', { code: ui_error, error: e.message.split('\n')[0], diagnostic: e.diagnostic });
    }

    const catalogue = models ? toCatalogue(models) : [];
    const learned = session.book.learned();
    const doc = {
      kind: 'page_facts',
      bl: facts.bl,
      xsrf_present: facts.xsrf_present,
      signed_in: facts.signed_in,
      models: catalogue.filter((m) => m.id).map(({ id, label, description, selected }) => ({ id, label, description, selected })),
      models_locked: catalogue.filter((m) => !m.id).map((m) => m.label),
      models_source: models ? 'picker' : 'none',
      picker_label,
      ui_ok,
      ...(ui_error ? { ui_error } : {}),
      ui_method: session.method,
      ...(Object.keys(learned).length ? { ui_selectors_learned: learned } : {}),
      anonymous: session.anonymous,
      user_agent: session.userAgent,
      captured_at: new Date().toISOString(),
    };
    assertNoSecrets(doc, session.secrets);
    return doc;
  } finally {
    clearTimeout(overall);
    await session.close();
  }
}
