// Page-side functions: each one is serialised (page.evaluate, isolated world) and runs
// inside gemini.google.com, so every function must be fully self-contained (no
// references to module scope). They only return structure and the texts the hub
// needs; none of them touches cookies, storage or token values.

/**
 * Who is signed in and on which plan, as the page shows it. Only a masked e-mail
 * leaves the page; no cookie, storage or token value is ever read.
 */
export function collectAccountFacts() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const acct = document.querySelector('a[aria-label^="Google Account" i], button[aria-label^="Google Account" i]');
  const label = acct ? acct.getAttribute('aria-label') || '' : '';
  const email = (/[\w.+-]+@[\w-]+(\.[\w-]+)+/.exec(label) || [''])[0];
  const mask = (e) => (e ? e.replace(/^(.{2})[^@]*/, '$1***') : '');
  const signInVisible = Array.from(document.querySelectorAll('a, button')).some(
    (el) => visible(el) && /^sign in$/i.test((el.innerText || el.getAttribute('aria-label') || '').trim()),
  );
  // Plan hints: the account entry in the sidebar shows the plan under the name
  // ("Pro", "Ultra"); an "Upgrade" call to action means a free plan. The model picker
  // and the chat are skipped (the picker can read "Pro" too).
  const skip = (el) => el.closest('button[data-test-id="bard-mode-menu-button"], rich-textarea, model-response, user-query, [role="menu"]');
  const leaves = Array.from(document.querySelectorAll('span, div, a, button, p'))
    .filter((el) => visible(el) && !skip(el) && el.children.length === 0)
    .map((el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' '))
    .filter((t) => t && t.length < 60);
  const upgrade = leaves.find((t) => /^(upgrade|upgrade to [\w ]+|try google ai [\w ]+|get google ai [\w ]+)$/i.test(t)) || '';
  const badge = leaves.find((t) => /^(pro|ultra|plus|ai pro|ai ultra|ai plus|google ai (pro|ultra|plus))$/i.test(t)) || '';
  const picker = document.querySelector('button[data-test-id="bard-mode-menu-button"], button[aria-label^="Open mode picker" i]');
  return {
    // The page's own globals are not visible from the isolated world; the caller adds
    // the XSRF-token presence from the page source.
    account_link: Boolean(acct),
    sign_in_visible: signInVisible,
    identity: mask(email),
    upgrade_hint: upgrade.slice(0, 60),
    plan_badge: badge.slice(0, 30),
    picker_label: picker ? picker.getAttribute('aria-label') || '' : '',
    path: location.pathname,
  };
}

/** Items of the open model picker menu. */
export function collectModelMenu() {
  return Array.from(document.querySelectorAll('[data-test-id^="bard-mode-option-"]')).map((el) => ({
    id: el.getAttribute('data-mode-id') || '',
    text: (el.innerText || el.textContent || '').trim(),
    enabled: el.getAttribute('aria-disabled') !== 'true',
    selected:
      el.getAttribute('data-active') === 'true' ||
      el.getAttribute('aria-checked') === 'true' ||
      el.getAttribute('aria-selected') === 'true' ||
      el.classList.contains('selected') ||
      el.classList.contains('is-selected'),
  }));
}

/** Visible alert-like texts (snackbars, dialogs, alerts), each cut to 300 characters. */
export function collectAlerts() {
  const sel = '[role="alert"], [role="alertdialog"], [role="dialog"], snack-bar-container, simple-snack-bar, .mat-mdc-snack-bar-container';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
    if (t) out.push(t.slice(0, 300));
  }
  return out;
}

/**
 * State of the chat: whether a generation is running and what the last answer
 * looks like. `args` = { answer: [selectors], stop: [selectors] } (ordered, first
 * selector with a match wins). Text is rebuilt from the DOM so code blocks come
 * out as fenced blocks; `code_blocks` holds the raw text of every code block.
 */
export function readChatState(args) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  let stop = false;
  for (const sel of args.stop) {
    try {
      if (Array.from(document.querySelectorAll(sel)).some(visible)) {
        stop = true;
        break;
      }
    } catch {
      // invalid selector: ignore
    }
  }

  let root = null;
  let count = 0;
  for (const sel of args.answer) {
    let found;
    try {
      found = document.querySelectorAll(sel);
    } catch {
      continue;
    }
    if (found.length) {
      root = found[found.length - 1];
      count = found.length;
      break;
    }
  }
  if (!root) return { stop, found: false, count: 0, busy: false, complete: false, text: '', code_blocks: [] };

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'BUTTON', 'SVG', 'MAT-ICON', 'GEM-ICON', 'GEM-ICON-BUTTON', 'SOURCES-LIST', 'MESSAGE-ACTIONS']);
  // Paragraph-like blocks are separated by a blank line, line-like blocks by a line break.
  const PARAGRAPH = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'TABLE']);
  const LINE = new Set(['DIV', 'LI', 'TR', 'SECTION', 'ARTICLE', 'HR']);
  const fences = [];
  const codeBlocks = [];
  let out = '';

  // Makes sure the text so far ends with at least n line breaks (no-op at the very start).
  const ensureBreaks = (n) => {
    out = out.replace(/[ \t]+$/, '');
    if (!out) return;
    const have = /\n*$/.exec(out)[0].length;
    if (have < n) out += '\n'.repeat(n - have);
  };
  const codeOf = (el) => {
    const c = el.querySelector('code[data-test-id="code-content"], pre code, code') || el;
    return (c.textContent || '').replace(/\n+$/, '');
  };
  const addFence = (el, lang) => {
    const code = codeOf(el);
    codeBlocks.push(code);
    fences.push('```' + lang + '\n' + code + '\n```');
    ensureBreaks(2);
    out += '\u0000' + (fences.length - 1) + '\u0000';
    ensureBreaks(2);
  };
  const walk = (n) => {
    if (n.nodeType === 3) {
      out += n.nodeValue.replace(/\s+/g, ' ');
      return;
    }
    if (n.nodeType !== 1) return;
    const tag = n.tagName;
    if (SKIP.has(tag) || n.hasAttribute('hidden') || n.classList.contains('cdk-visually-hidden')) return;
    if (tag === 'CODE-BLOCK') {
      const label = n.querySelector('.code-block-decoration span');
      const lang = label ? (label.textContent || '').trim().toLowerCase() : '';
      addFence(n, /^[a-z0-9+#._-]{1,20}$/.test(lang) ? lang : '');
      return;
    }
    if (tag === 'PRE') {
      addFence(n, '');
      return;
    }
    if (tag === 'BR') {
      out += '\n';
      return;
    }
    const breaks = PARAGRAPH.has(tag) ? 2 : LINE.has(tag) ? 1 : 0;
    if (breaks) ensureBreaks(breaks);
    if (/^H[1-6]$/.test(tag)) out += '#'.repeat(Number(tag[1])) + ' ';
    if (tag === 'LI') {
      const parent = n.parentElement;
      out += parent && parent.tagName === 'OL' ? Array.prototype.indexOf.call(parent.children, n) + 1 + '. ' : '- ';
    }
    if (tag === 'TD' || tag === 'TH') out += ' | ';
    for (const child of n.childNodes) walk(child);
    if (breaks) ensureBreaks(breaks);
  };
  walk(root);

  const text = out
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    // eslint-disable-next-line no-control-regex
    .replace(/\u0000(\d+)\u0000/g, (_, i) => fences[Number(i)]);

  // aria-busy sits on the markdown container inside message-content (or on an ancestor).
  let busy = Boolean(root.querySelector('[aria-busy="true"]'));
  for (let el = root; el && !busy; el = el.parentElement) busy = el.getAttribute('aria-busy') === 'true';
  // The response footer gets the class "complete" when Gemini has finished the turn.
  const container = root.closest('model-response');
  const footer = container ? container.querySelector('.response-footer') : null;
  const complete = Boolean(footer && footer.classList.contains('complete'));
  return { stop, found: true, count, busy, complete, text, code_blocks: codeBlocks };
}
