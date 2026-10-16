// BrowserSession logic against a scripted fake page (no browser, no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectAlerts, readChatState } from '../dom.mjs';
import { collectAnswerOutline } from '../ai.mjs';
import { BrowserSession, DEFAULT_SELECTORS, SelectorBook, UiError } from '../session.mjs';

const FAST = { poll: 5, stable: 30, aiAfter: 40, aiVerify: 60, giveUpAfter: 120 };

const chat = (over = {}) => ({ stop: false, found: true, count: 1, busy: false, text: 'pong', code_blocks: [], ...over });

/**
 * Fake of the Playwright page: `state(arg)` answers readChatState, `alerts()` answers
 * collectAlerts. Everything pageDiagnostic needs is present but empty.
 */
function fakePage({ state, alerts = () => [] }) {
  const evaluated = [];
  return {
    evaluated,
    evaluate: async (fn, arg) => {
      if (fn === readChatState) return state(arg);
      if (fn === collectAlerts) return alerts();
      if (fn === collectAnswerOutline) {
        evaluated.push('outline');
        return { url_path: '/app', elements: [{ tag: 'my-answer', text_len: 4 }] };
      }
      throw new Error('unexpected evaluate');
    },
    url: () => 'https://gemini.google.com/app/abc123def456',
    title: async () => 'Gemini',
    locator: () => ({ evaluateAll: async () => [] }),
  };
}

const session = (opts = {}) => new BrowserSession({ timing: FAST, ...opts });

/** A state function that plays `states` in order and repeats the last one. */
const playlist = (states) => {
  let i = 0;
  return () => states[Math.min(i++, states.length - 1)];
};

test('SelectorBook: learned selectors come first, forget removes them, defaults stay', () => {
  const book = new SelectorBook();
  assert.deepEqual(book.list('answer'), DEFAULT_SELECTORS.answer);
  assert.equal(book.learn('answer', 'my-answer'), true);
  assert.equal(book.learn('answer', 'my-answer'), false);
  assert.equal(book.learn('answer', ''), false);
  assert.deepEqual(book.list('answer'), ['my-answer', ...DEFAULT_SELECTORS.answer]);
  assert.deepEqual(book.learned(), { answer: ['my-answer'] });
  book.forget('answer', 'my-answer');
  assert.deepEqual(book.learned(), {});
  assert.deepEqual(book.list('answer'), DEFAULT_SELECTORS.answer);
});

test('awaitAnswer waits for the stop button to vanish and the text to settle', async () => {
  const page = fakePage({
    state: playlist([
      chat({ stop: true, text: '' }),
      chat({ stop: true, text: 'po' }),
      chat({ stop: false, text: 'pon' }),
      chat({ stop: false, text: 'pong' }),
    ]),
  });
  const out = await session().awaitAnswer(page, { ceilingMs: 5000 });
  assert.deepEqual(out, { text: 'pong', code_blocks: [] });
});

test('awaitAnswer does not return while the answer is marked busy or the stop button shows', async () => {
  let calls = 0;
  const page = fakePage({
    state: () => (++calls < 12 ? chat({ busy: true, text: 'partial' }) : chat({ text: 'final' })),
  });
  const out = await session().awaitAnswer(page, { ceilingMs: 5000 });
  assert.equal(out.text, 'final');
  assert.ok(calls >= 12);
});

test('awaitAnswer returns the code blocks next to the text', async () => {
  const page = fakePage({ state: () => chat({ text: '```json\n{"a":1}\n```', code_blocks: ['{"a":1}'] }) });
  const out = await session().awaitAnswer(page, { ceilingMs: 5000 });
  assert.deepEqual(out.code_blocks, ['{"a":1}']);
});

test('awaitAnswer: a usage-limit alert becomes upstream_rate_limited', async () => {
  const page = fakePage({
    state: () => chat({ stop: true, text: '' }),
    alerts: () => ['You have reached your limit. Try again later.'],
  });
  await assert.rejects(session().awaitAnswer(page, { ceilingMs: 5000 }), (e) => e instanceof UiError && e.code === 'upstream_rate_limited');
});

test('awaitAnswer: a limit message as the answer text becomes upstream_rate_limited; a normal answer about limits does not', async () => {
  const limited = fakePage({ state: () => chat({ text: "You've reached your usage limit for Gemini. Try again tomorrow." }) });
  await assert.rejects(session().awaitAnswer(limited, { ceilingMs: 5000 }), (e) => e.code === 'upstream_rate_limited');
  const normal = fakePage({ state: () => chat({ text: 'The speed limit is 50 km/h.' }) });
  assert.equal((await session().awaitAnswer(normal, { ceilingMs: 5000 })).text, 'The speed limit is 50 km/h.');
});

test('awaitAnswer: sign-in wall -> no_valid_account, generic failure -> upstream_unavailable', async () => {
  const signIn = fakePage({ state: () => chat({ stop: true, text: '' }), alerts: () => ['Sign in to continue'] });
  await assert.rejects(session().awaitAnswer(signIn, { ceilingMs: 5000 }), (e) => e.code === 'no_valid_account');
  const failure = fakePage({ state: () => chat({ stop: true, text: '' }), alerts: () => ['Something went wrong.'] });
  await assert.rejects(session().awaitAnswer(failure, { ceilingMs: 5000 }), (e) => e.code === 'upstream_unavailable');
});

test('awaitAnswer without any answer container and without an AI key: upstream_protocol_changed', async () => {
  const page = fakePage({ state: () => chat({ found: false, count: 0, text: '' }) });
  await assert.rejects(session().awaitAnswer(page, { ceilingMs: 5000 }), (e) => e.code === 'upstream_protocol_changed' && /answer container/.test(e.message));
});

test('awaitAnswer asks the AI for an answer selector, learns it and reports it', async () => {
  const learned = [];
  const proposals = [];
  const fetchImpl = async (url, init) => {
    proposals.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ answer_selector: 'my-answer', stop_selector: 'button.halt', notes: 'n' }) }] } }] }) };
  };
  const s = session({ aiKey: 'KEY-12345678', fetchImpl, onSelectorsLearned: (sel) => learned.push(sel) });
  const page = fakePage({
    // Only the AI-proposed selector finds the answer.
    state: (arg) => (arg.answer[0] === 'my-answer' ? chat({ text: 'recovered answer' }) : chat({ found: false, count: 0, text: '' })),
  });
  const out = await s.awaitAnswer(page, { ceilingMs: 5000 });
  assert.equal(out.text, 'recovered answer');
  assert.deepEqual(learned, [{ answer: ['my-answer'] }, { answer: ['my-answer'], stop: ['button.halt'] }]);
  assert.equal(s.method, 'ai-selectors');
  assert.equal(proposals.length, 1);
  const sent = proposals[0].contents[0].parts[0].text;
  assert.match(sent, /answer_selector/);
  assert.ok(!sent.includes('KEY-12345678'));
});

test('an AI-proposed answer selector that matches nothing is forgotten and fails the request', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"answer_selector":"nothing-here","stop_selector":"","notes":""}' }] } }] }) });
  const s = session({ aiKey: 'KEY-12345678', fetchImpl });
  const page = fakePage({ state: () => chat({ found: false, count: 0, text: '' }) });
  await assert.rejects(s.awaitAnswer(page, { ceilingMs: 5000 }), (e) => e.code === 'upstream_protocol_changed' && /AI-proposed/.test(e.message));
  assert.deepEqual(s.book.learned(), {});
});

test('a failing AI proposal call is reported as upstream_protocol_changed', async () => {
  const s = session({ aiKey: 'KEY-12345678', fetchImpl: async () => ({ ok: false, status: 429 }) });
  const page = fakePage({ state: () => chat({ found: false, count: 0, text: '' }) });
  await assert.rejects(s.awaitAnswer(page, { ceilingMs: 5000 }), (e) => e.code === 'upstream_protocol_changed' && /HTTP 429/.test(e.message));
});

test('the ceiling is the only time limit: an answer that never finishes ends as upstream_unavailable', async () => {
  const page = fakePage({ state: () => chat({ stop: true, text: 'still going' }) });
  await assert.rejects(session().awaitAnswer(page, { ceilingMs: 150 }), (e) => e.code === 'upstream_unavailable' && /no finished answer/.test(e.message));
});

test('ask() attaches long prompts as prompt.txt and types a short instruction', async () => {
  const s = session();
  const calls = [];
  const page = { close: async () => calls.push('close') };
  s.openChat = async () => page;
  s.selectModel = async () => calls.push('select');
  s.attach = async (_p, files) => calls.push(['attach', files.map((f) => [f.name, f.mime, f.data.length])]);
  s.submit = async (_p, text, o) => calls.push(['submit', text, o.sendWaitMs]);
  s.awaitAnswer = async () => ({ text: '```json\n{"a":1}\n```', code_blocks: ['{"a":1}'] });
  s.pickerLabel = async () => 'Flash-Lite';

  const big = 'x'.repeat(31 * 1024);
  const out = await s.ask({ prompt: big, modelLabel: '3.6 Flash', json: true });
  assert.deepEqual(out, { model_label_seen: 'Flash-Lite', text: '{"a":1}', json_valid: true });
  assert.deepEqual(calls[0], 'select');
  assert.deepEqual(calls[1], ['attach', [['prompt.txt', 'text/plain', big.length]]]);
  assert.equal(calls[2][0], 'submit');
  assert.match(calls[2][1], /attached file prompt\.txt/);
  assert.ok(!calls[2][1].includes('xxxx'));
  assert.equal(calls[2][2], 120000);
  assert.equal(calls.at(-1), 'close');

  calls.length = 0;
  const small = await s.ask({ prompt: 'short prompt', attachments: [] });
  assert.deepEqual(small, { model_label_seen: 'Flash-Lite', text: '```json\n{"a":1}\n```' });
  assert.deepEqual(calls, [['submit', 'short prompt', 6000], 'close']);

  calls.length = 0;
  await s.ask({ prompt: 'p', attachments: [{ name: 'a.txt', mime: 'text/plain', data: Buffer.from('abc') }] });
  assert.deepEqual(calls[0], ['attach', [['a.txt', 'text/plain', 3]]]);
  assert.equal(calls[1][1], 'p', 'a short prompt stays inline next to explicit attachments');
});

test('ask() closes the page when a step fails', async () => {
  const s = session();
  let closed = false;
  s.openChat = async () => ({ close: async () => (closed = true) });
  s.submit = async () => {
    throw new UiError('upstream_protocol_changed', 'x');
  };
  await assert.rejects(s.ask({ prompt: 'p' }), (e) => e.code === 'upstream_protocol_changed');
  assert.equal(closed, true);
});
