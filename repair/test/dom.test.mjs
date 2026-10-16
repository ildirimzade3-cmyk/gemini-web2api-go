// Runs the page-side functions (dom.mjs) against the static fixture in a real
// Chromium. The fixture is loaded with setContent, so there is no network. The
// suite is skipped when no Chromium is available (set CHROMIUM_PATH to run it).

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { DEFAULT_SELECTORS } from '../session.mjs';
import { collectDomFacts, collectModelMenu, readChatState } from '../dom.mjs';
import { derivePageFacts, parseModelItems } from '../facts.mjs';

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try {
    const p = chromium.executablePath();
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}
const exe = findChromium();
const args = { answer: [...DEFAULT_SELECTORS.answer], stop: [...DEFAULT_SELECTORS.stop] };

const EXPECTED_TEXT = [
  'Here is the result.',
  '',
  '### Details',
  '',
  '- First item',
  '- Second bold item',
  '',
  '```json',
  '{',
  '  "title": "Example",',
  '  "tags": ["a", "b"]',
  '}',
  '```',
  '',
  'Hope that helps.',
].join('\n');

describe('page-side functions on the chat fixture', { skip: exe ? false : 'no Chromium (set CHROMIUM_PATH)' }, () => {
  let browser;
  let page;
  let html;
  before(async () => {
    html = await readFile(new URL('./fixtures/chat.html', import.meta.url), 'utf8');
    browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--no-sandbox'] });
  });
  after(async () => {
    await browser?.close();
  });
  const fresh = async () => {
    await page?.close();
    page = await browser.newPage();
    await page.setContent(html);
  };

  test('readChatState rebuilds the answer text with a fenced JSON block and returns the raw code', async () => {
    await fresh();
    const st = await page.evaluate(readChatState, args);
    assert.equal(st.found, true);
    assert.equal(st.stop, false);
    assert.equal(st.busy, false);
    assert.equal(st.count, 1);
    assert.equal(st.text, EXPECTED_TEXT);
    assert.deepEqual(st.code_blocks, ['{\n  "title": "Example",\n  "tags": ["a", "b"]\n}']);
    assert.ok(!st.text.includes('Good response'), 'action buttons are not part of the answer');
    assert.ok(!st.text.includes('Gemini said'), 'the hidden screen-reader label is not part of the answer');
    assert.deepEqual(JSON.parse(st.code_blocks[0]), { title: 'Example', tags: ['a', 'b'] });
  });

  test('readChatState sees a running generation (visible stop button, aria-busy)', async () => {
    await fresh();
    await page.evaluate(() => {
      document.getElementById('stop').style.display = 'inline-block';
      document.querySelector('.markdown').setAttribute('aria-busy', 'true');
    });
    const st = await page.evaluate(readChatState, args);
    assert.equal(st.stop, true);
    assert.equal(st.busy, true);
  });

  test('readChatState falls through the ordered selectors and reports a missing answer', async () => {
    await fresh();
    const viaSecond = await page.evaluate(readChatState, { ...args, answer: ['nope-element', 'model-response .markdown'] });
    assert.equal(viaSecond.found, true);
    assert.equal(viaSecond.text, EXPECTED_TEXT);
    const none = await page.evaluate(readChatState, { ...args, answer: ['nope-element', '[bad selector((']} );
    assert.deepEqual(none, { stop: false, found: false, count: 0, busy: false, text: '', code_blocks: [] });
  });

  test('readChatState picks the newest of several answers', async () => {
    await fresh();
    await page.evaluate(() => {
      const first = document.querySelector('model-response');
      const second = first.cloneNode(true);
      second.querySelector('.markdown').innerHTML = '<p>Second answer</p>';
      first.after(second);
    });
    const st = await page.evaluate(readChatState, args);
    assert.equal(st.count, 2);
    assert.equal(st.text, 'Second answer');
    assert.deepEqual(st.code_blocks, []);
  });

  test('collectModelMenu + parseModelItems read the picker menu', async () => {
    await fresh();
    const models = parseModelItems(await page.evaluate(collectModelMenu));
    assert.deepEqual(
      models.map((m) => [m.id, m.label, m.description, m.enabled, m.selected]),
      [
        ['cf41b0e0dd7d53e5', '3.5 Flash-Lite', 'Fastest answers', true, true],
        ['fbb127bbb056c959', '3.6 Flash', 'All-around help', true, false],
        ['', '3.1 Pro', 'Advanced reasoning', false, false],
      ],
    );
  });

  test('collectDomFacts + derivePageFacts: signed-in fixture, then with a sign-in link', async () => {
    await fresh();
    const dom = await page.evaluate(collectDomFacts);
    const facts = derivePageFacts({ source: await page.content(), dom });
    assert.deepEqual(facts, { bl: 'boq_gemini-web-uiserver_20261015.13_p0', xsrf_present: true, signed_in: true, picker_label: 'Flash-Lite' });
    assert.ok(!JSON.stringify(dom).includes('AEXAMPLE'), 'the XSRF value never leaves the page');

    await page.evaluate(() => {
      const a = document.createElement('a');
      a.href = 'https://accounts.google.com/ServiceLogin?continue=x';
      document.body.append(a);
    });
    const anon = derivePageFacts({ source: await page.content(), dom: await page.evaluate(collectDomFacts) });
    assert.equal(anon.signed_in, false);
  });
});
