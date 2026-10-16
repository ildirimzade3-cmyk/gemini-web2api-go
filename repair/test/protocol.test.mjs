import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNoSecrets,
  buildLearned,
  buildTemplate,
  extractAnswerTexts,
  filterHeaders,
  findPromptPath,
  formAt,
  parseEndpoint,
  parseFReq,
  renderRequest,
  responseHasWord,
  templateHeaders,
} from '../protocol.mjs';
import { AT_TOKEN, COOKIE_VALUE, HDR_UUID, PROMPT, REQ_UUID, makeCapture, makeInner } from './helpers.mjs';

test('parseFReq decodes the outer array and the inner JSON', () => {
  const p = parseFReq(makeCapture().body);
  assert.equal(p.outer[0], null);
  assert.equal(p.inner_index, 1);
  assert.equal(p.inner.length, 97);
  assert.equal(p.inner[0][0], PROMPT);
  assert.deepEqual(p.form_fields, ['f.req', 'at']);
});

test('parseFReq rejects bodies without f.req or with a bad shape', () => {
  assert.throws(() => parseFReq('at=x'), /f\.req/);
  assert.throws(() => parseFReq('f.req=' + encodeURIComponent('{"a":1}')), /not an array/);
  assert.throws(() => parseFReq('f.req=' + encodeURIComponent('[1,2]')), /no inner/);
});

test('findPromptPath finds exact matches, falls back to substrings, and returns null when absent', () => {
  assert.deepEqual(findPromptPath(makeInner(), PROMPT), [0, 0]);
  // an exact match later in the tree wins over an earlier substring match
  assert.deepEqual(findPromptPath([['contains ' + PROMPT + ' inside'], [[PROMPT]]], PROMPT), [1, 0, 0]);
  assert.deepEqual(findPromptPath([['x ' + PROMPT]], PROMPT), [0, 0]);
  assert.equal(findPromptPath(makeInner(), 'something else'), null);
});

test('buildTemplate replaces the prompt, uuids and conversation ids', () => {
  const inner = makeInner();
  inner[3] = 'c_1a2b3c4d5e6f7a8b';
  const { template, uuid_paths, nulled_paths } = buildTemplate(inner, [0, 0], PROMPT);
  assert.equal(template[0][0], '__PROMPT__');
  assert.equal(template[59], '__UUID__');
  assert.equal(template[3], null);
  assert.deepEqual(uuid_paths, [[59]]);
  assert.deepEqual(nulled_paths, [[3]]);
  assert.equal(inner[0][0], PROMPT, 'input must not be mutated');
});

test('buildTemplate keeps surrounding text when the prompt is a substring', () => {
  const inner = makeInner('wrapped ' + PROMPT + '!');
  const { template } = buildTemplate(inner, [0, 0], PROMPT);
  assert.equal(template[0][0], 'wrapped __PROMPT__!');
});

test('filterHeaders keeps only x-goog-ext-* and x-same-domain, never cookies or authorization', () => {
  const out = filterHeaders(makeCapture().headers);
  assert.deepEqual(Object.keys(out).sort(), [
    'x-goog-ext-525001261-jspb',
    'x-goog-ext-525005358-jspb',
    'x-goog-ext-73010989-jspb',
    'x-same-domain',
  ]);
  assert.ok(!JSON.stringify(out).includes(COOKIE_VALUE));
});

test('templateHeaders swaps header uuids for the placeholder', () => {
  const out = templateHeaders(filterHeaders(makeCapture().headers));
  assert.ok(out['x-goog-ext-525001261-jspb'].endsWith(',"__UUID__"]'));
  assert.equal(out['x-goog-ext-525005358-jspb'], '["__UUID__",1]');
});

test('parseEndpoint extracts bl and drops per-request query params', () => {
  const e = parseEndpoint(makeCapture().url);
  assert.equal(e.bl, 'boq_gemini-web-uiserver_20261015.13_p0');
  assert.deepEqual(e.query, { bl: e.bl, hl: 'en', rt: 'c' });
  assert.deepEqual(e.query_dropped.sort(), ['_reqid', 'f.sid']);
  assert.match(e.endpoint_path, /StreamGenerate$/);
});

test('buildLearned never contains cookie or at values and has the documented fields', () => {
  const learned = buildLearned({
    capture: makeCapture(),
    prompt: PROMPT,
    ui: { input: 'div.ql-editor', send: 'button[aria-label*="send" i]', method: 'selectors' },
    userAgent: 'UA',
    anonymous: false,
    now: new Date('2026-10-17T00:00:00Z'),
  });
  const text = JSON.stringify(learned);
  for (const secret of [COOKIE_VALUE, AT_TOKEN, REQ_UUID, HDR_UUID]) assert.ok(!text.includes(secret), secret);
  assert.equal(learned.source, 'browser');
  assert.equal(learned.captured_at, '2026-10-17T00:00:00.000Z');
  assert.deepEqual(learned.prompt_path, [0, 0]);
  assert.equal(learned.inner_template[0][0], '__PROMPT__');
  assert.equal(learned.response_ok, true);
  assert.equal(learned.method, 'selectors');
  assert.deepEqual(learned.outer_template, [null, '__INNER__']);
  assert.ok(learned.model_header.includes('fbb127bbb056c959'));
  assert.deepEqual(learned.form_fields, ['f.req', 'at']);
  assert.doesNotThrow(() => assertNoSecrets(learned, [COOKIE_VALUE, AT_TOKEN]));
});

test('buildLearned records the AI proposal but nothing from the page', () => {
  const learned = buildLearned({
    capture: makeCapture(),
    prompt: PROMPT,
    ui: { input: 'x', send: 'Enter', method: 'ai-selectors', ai_proposal: { input_selector: 'x', send_selector: '', notes: 'n' } },
    userAgent: 'UA',
    anonymous: true,
  });
  assert.equal(learned.method, 'ai-selectors');
  assert.equal(learned.ai_proposal.input_selector, 'x');
  assert.equal(learned.anonymous, true);
});

test('buildLearned fails when the prompt is not inside f.req', () => {
  assert.throws(
    () => buildLearned({ capture: makeCapture({ prompt: 'other' }), prompt: PROMPT, ui: {}, userAgent: 'UA' }),
    /prompt text not found/,
  );
});

test('renderRequest turns the template back into an equivalent request', () => {
  const cap = makeCapture();
  const learned = buildLearned({ capture: cap, prompt: PROMPT, ui: { input: 'i', send: 's', method: 'selectors' }, userAgent: 'UA' });
  const uuids = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002'];
  let n = 0;
  const req = renderRequest(learned, { prompt: 'hello there', uuid: () => uuids[n++ % 2], reqid: 4242, at: 'TOKEN' });
  const u = new URL(req.url);
  assert.equal(u.searchParams.get('bl'), learned.bl);
  assert.equal(u.searchParams.get('_reqid'), '4242');
  assert.equal(u.searchParams.get('f.sid'), null);
  const parsed = parseFReq(req.body);
  assert.equal(parsed.inner[0][0], 'hello there');
  assert.equal(parsed.inner[59], uuids[0]);
  assert.equal(formAt(req.body), 'TOKEN');
  assert.ok(!req.headers['x-goog-ext-525001261-jspb'].includes('__UUID__'));
  // everything except the prompt and the uuid matches the original capture
  const orig = parseFReq(cap.body).inner;
  const back = parsed.inner.map((v, i) => (i === 59 || i === 0 ? orig[i] : v));
  assert.deepEqual(back, orig);
});

test('renderRequest omits at when none is given', () => {
  const learned = buildLearned({ capture: makeCapture(), prompt: PROMPT, ui: {}, userAgent: 'UA' });
  assert.equal(formAt(renderRequest(learned, { prompt: 'x', uuid: 'u-u', reqid: 1 }).body), null);
});

test('assertNoSecrets throws on a leaked value and ignores short values', () => {
  assert.throws(() => assertNoSecrets({ a: `x${COOKIE_VALUE}y` }, [COOKIE_VALUE]), /secret/);
  assert.doesNotThrow(() => assertNoSecrets({ a: '1' }, ['1', undefined, null]));
});

test('responseHasWord reads the answer text, not the echoed prompt or title', () => {
  assert.equal(responseHasWord(makeCapture().raw), true);
  assert.equal(responseHasWord(makeCapture({ answer: 'Pong.' }).raw), true);
  assert.equal(responseHasWord(makeCapture({ answer: 'I cannot do that' }).raw), false);
  assert.equal(responseHasWord(''), false);
  assert.equal(responseHasWord('garbage with pong inside'), false);
});

test('extractAnswerTexts falls back to all payload strings when the known path moves', () => {
  const payload = JSON.stringify([null, null, null, null, null, [['x', ['pong']]]]);
  const raw = JSON.stringify([['wrb.fr', null, payload]]);
  assert.ok(extractAnswerTexts(raw).includes('pong'));
});

test('formAt returns the at field', () => {
  assert.equal(formAt(makeCapture().body), AT_TOKEN);
});
