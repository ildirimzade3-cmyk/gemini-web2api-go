import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AI_MODEL,
  ProposalError,
  buildAiPrompt,
  buildAnswerPrompt,
  proposeAnswerSelectors,
  proposeSelectors,
  trimSummary,
  validateAnswerProposal,
  validateProposal,
} from '../ai.mjs';
import { toPlaywrightCookies } from '../session.mjs';

test('validateProposal accepts a good proposal and normalises an empty send selector to null', () => {
  assert.deepEqual(
    validateProposal({ input_selector: ' div.ql-editor ', send_selector: '', notes: 'ok' }),
    { input_selector: 'div.ql-editor', send_selector: null, notes: 'ok' },
  );
  assert.equal(validateProposal({ input_selector: 'textarea', send_selector: 'button.send', notes: 'x' }).send_selector, 'button.send');
});

test('validateProposal rejects missing, oversized, multi-line and non-CSS selectors', () => {
  const bad = [
    null,
    [],
    {},
    { input_selector: '   ' },
    { input_selector: 42 },
    { input_selector: 'a'.repeat(301) },
    { input_selector: 'div\nspan' },
    { input_selector: 'text=Send' },
    { input_selector: '//div[@id="x"]' },
    { input_selector: 'textarea', send_selector: 'xpath=//button' },
  ];
  for (const b of bad) assert.throws(() => validateProposal(b), ProposalError, JSON.stringify(b));
});

test('trimSummary drops invisible elements and keeps the result under the byte budget', () => {
  const elements = Array.from({ length: 2000 }, (_, i) => ({ tag: 'button', visible: i % 2 === 0, 'aria-label': 'Label number ' + i }));
  const out = trimSummary({ url_path: '/app', title: 't', elements }, 4000);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 4000);
  assert.ok(out.elements.length > 0);
  assert.ok(out.elements.every((e) => e.visible));
  assert.equal(out.url_path, '/app');
});

test('buildAiPrompt embeds the summary as data', () => {
  const p = buildAiPrompt({ elements: [{ tag: 'textarea' }] });
  assert.match(p, /input_selector/);
  assert.match(p, /"tag":"textarea"/);
});

function fakeGemini(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return responder(calls.length);
  };
  return { calls, fetchImpl };
}
const ok = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });

test('proposeSelectors calls generateContent with key header, JSON mime type and schema, and keeps the key out of the body', async () => {
  const { calls, fetchImpl } = fakeGemini(() => ok(JSON.stringify({ input_selector: 'div.x', send_selector: 'button.y', notes: 'n' })));
  const res = await proposeSelectors({ elements: [] }, { apiKey: 'KEY-12345678', fetchImpl });
  assert.deepEqual(res, { input_selector: 'div.x', send_selector: 'button.y', notes: 'n' });
  const { url, init, body } = calls[0];
  assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_AI_MODEL}:generateContent`);
  assert.equal(DEFAULT_AI_MODEL, 'gemini-3.6-flash');
  assert.equal(init.headers['x-goog-api-key'], 'KEY-12345678');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseSchema.required, ['input_selector', 'send_selector', 'notes']);
  assert.ok(!JSON.stringify(body).includes('KEY-12345678'));
  assert.ok(!url.includes('KEY-12345678'));
});

test('proposeSelectors honours the model override', async () => {
  const { calls, fetchImpl } = fakeGemini(() => ok('{"input_selector":"a","send_selector":"","notes":""}'));
  await proposeSelectors({ elements: [] }, { apiKey: 'k'.repeat(10), model: 'gemini-x', fetchImpl });
  assert.match(calls[0].url, /models\/gemini-x:generateContent$/);
});

test('proposeSelectors reports a missing key, HTTP errors, empty and non-JSON answers', async () => {
  await assert.rejects(proposeSelectors({}, { apiKey: '' }), /not set/);
  await assert.rejects(proposeSelectors({}, { apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 429 }) }), /HTTP 429/);
  await assert.rejects(proposeSelectors({}, { apiKey: 'k', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /no text/);
  await assert.rejects(proposeSelectors({}, { apiKey: 'k', fetchImpl: async () => ok('not json') }), /non-JSON/);
  await assert.rejects(proposeSelectors({}, { apiKey: 'k', fetchImpl: async () => ok('{"input_selector":"text=Send"}') }), ProposalError);
});

test('toPlaywrightCookies keeps only google.com cookies and sets __Host- cookies by url', () => {
  const out = toPlaywrightCookies([
    { name: 'SID', value: 'v1', domain: '.google.com', path: '/', secure: true, httpOnly: true },
    { name: '__Host-GAPS', value: 'v2', domain: 'accounts.google.com', path: '/' },
    { name: 'other', value: 'v3', domain: '.example.com' },
    { name: 'nodomain', value: 'v4' },
    { name: 'bad' },
    null,
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { name: 'SID', value: 'v1', secure: true, httpOnly: true, domain: '.google.com', path: '/' });
  assert.deepEqual(out[1], { name: '__Host-GAPS', value: 'v2', secure: true, httpOnly: false, url: 'https://accounts.google.com/' });
  assert.equal(out[2].domain, '.google.com');
});

test('validateAnswerProposal accepts a good proposal and rejects unusable ones', () => {
  assert.deepEqual(validateAnswerProposal({ answer_selector: ' model-response .markdown ', stop_selector: '', notes: 'ok' }), {
    answer_selector: 'model-response .markdown',
    stop_selector: null,
    notes: 'ok',
  });
  for (const bad of [null, {}, { answer_selector: '' }, { answer_selector: 'text=Answer' }, { answer_selector: 'a', stop_selector: '//button' }, { answer_selector: 'a\nb' }]) {
    assert.throws(() => validateAnswerProposal(bad), ProposalError, JSON.stringify(bad));
  }
});

test('buildAnswerPrompt embeds the outline as data and names the wanted fields', () => {
  const p = buildAnswerPrompt({ elements: [{ tag: 'model-response', text_len: 12 }] });
  assert.match(p, /answer_selector/);
  assert.match(p, /stop_selector/);
  assert.match(p, /"tag":"model-response"/);
});

test('proposeAnswerSelectors uses the answer schema and the same key handling', async () => {
  const { calls, fetchImpl } = fakeGemini(() => ok(JSON.stringify({ answer_selector: 'my-answer', stop_selector: 'button.halt', notes: 'n' })));
  const res = await proposeAnswerSelectors({ elements: [] }, { apiKey: 'KEY-12345678', fetchImpl });
  assert.deepEqual(res, { answer_selector: 'my-answer', stop_selector: 'button.halt', notes: 'n' });
  assert.deepEqual(calls[0].body.generationConfig.responseSchema.required, ['answer_selector', 'stop_selector', 'notes']);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'KEY-12345678');
  assert.ok(!JSON.stringify(calls[0].body).includes('KEY-12345678'));
  await assert.rejects(proposeAnswerSelectors({}, { apiKey: '' }), /not set/);
});
