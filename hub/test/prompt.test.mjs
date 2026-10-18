import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FILES,
  RequestError,
  buildPrompt,
  checkSchema,
  extractJson,
  fromGemini,
  fromOpenAI,
  geminiJson,
  jsonInstruction,
  judgeJson,
  openAIJson,
} from '../src/prompt.mjs';
import { openAIThinking, geminiThinking } from '../src/prompt.mjs';

const PNG_B64 = Buffer.from('fakepng').toString('base64');
const dataUrl = (mime = 'image/png') => `data:${mime};base64,${PNG_B64}`;

test('fromOpenAI: string content', () => {
  const r = fromOpenAI({ messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(r, { system: [], turns: [{ role: 'user', text: 'hi', files: [] }] });
});

test('fromOpenAI: text + image_url data URL', () => {
  const r = fromOpenAI({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: dataUrl() } }] }],
  });
  assert.equal(r.turns[0].text, 'look');
  assert.equal(r.turns[0].files.length, 1);
  assert.equal(r.turns[0].files[0].mime, 'image/png');
  assert.equal(r.turns[0].files[0].name, 'file1.png');
  assert.equal(r.turns[0].files[0].data.toString(), 'fakepng');
});

test('fromOpenAI: remote image URL, unknown part, bad role, empty messages rejected', () => {
  assert.throws(
    () => fromOpenAI({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://example.com/a.png' } }] }] }),
    (e) => e instanceof RequestError && /never fetches remote URLs/.test(e.message) && e.status === 400,
  );
  assert.throws(() => fromOpenAI({ messages: [{ role: 'user', content: [{ type: 'video', x: 1 }] }] }), /unsupported content part type "video"/);
  assert.throws(() => fromOpenAI({ messages: [{ role: 'wizard', content: 'x' }] }), /unsupported role/);
  assert.throws(() => fromOpenAI({ messages: [] }), /non-empty/);
  assert.throws(() => fromOpenAI({}), /non-empty/);
});

test('fromOpenAI: system/developer collected, assistant and tool roles', () => {
  const r = fromOpenAI({
    messages: [
      { role: 'system', content: 'S1' },
      { role: 'developer', content: [{ type: 'text', text: 'D1' }] },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
      { role: 'tool', content: 'result' },
    ],
  });
  assert.deepEqual(r.system, ['S1', 'D1']);
  assert.deepEqual(
    r.turns.map((t) => [t.role, t.text]),
    [['user', 'u'], ['assistant', 'a'], ['user', 'Tool result:\nresult']],
  );
});

test('fromGemini: systemInstruction, inlineData, model role', () => {
  const r = fromGemini({
    systemInstruction: { parts: [{ text: 'be brief' }, { text: 'be kind' }] },
    contents: [
      { role: 'user', parts: [{ text: 'q' }, { inlineData: { mimeType: 'application/pdf', data: PNG_B64 } }] },
      { role: 'model', parts: [{ text: 'a' }] },
      { parts: [{ text: 'q2' }] },
    ],
  });
  assert.deepEqual(r.system, ['be brief\nbe kind']);
  assert.deepEqual(
    r.turns.map((t) => t.role),
    ['user', 'assistant', 'user'],
  );
  assert.equal(r.turns[0].files[0].name, 'file1.pdf');
  assert.equal(fromGemini({ system_instruction: { parts: [{ text: 'x' }] }, contents: [{ parts: [{ text: 'q' }] }] }).system[0], 'x');
});

test('fromGemini: fileData and empty contents rejected', () => {
  assert.throws(() => fromGemini({ contents: [{ parts: [{ fileData: { fileUri: 'gs://x' } }] }] }), /fileData/);
  assert.throws(() => fromGemini({ contents: [{ parts: [{ functionCall: {} }] }] }), /unsupported part/);
  assert.throws(() => fromGemini({ contents: [] }), /non-empty/);
  assert.throws(() => fromGemini({ contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: '' } }] }] }), /empty inline file/);
});

test('buildPrompt: single user turn is sent verbatim', () => {
  const p = buildPrompt({ system: [], turns: [{ role: 'user', text: '  raw  text ', files: [] }] });
  assert.equal(p.text, '  raw  text ');
  assert.deepEqual(p.files, []);
});

test('buildPrompt: system + history layout', () => {
  const only = buildPrompt({ system: ['Rule'], turns: [{ role: 'user', text: 'Q', files: [] }] });
  assert.equal(only.text, 'Instructions (follow them):\nRule\n\nQ');
  const full = buildPrompt({
    system: ['A', ' ', 'B'],
    turns: [
      { role: 'user', text: 'one', files: [] },
      { role: 'assistant', text: 'two', files: [] },
      { role: 'user', text: 'three', files: [] },
    ],
  });
  assert.equal(
    full.text,
    'Instructions (follow them):\nA\n\nB\n\nConversation so far:\nUser: one\n\nAssistant: two\n\nCurrent message from the user:\nthree',
  );
  const hist = buildPrompt({
    system: [],
    turns: [
      { role: 'user', text: 'one', files: [] },
      { role: 'assistant', text: 'two', files: [] },
      { role: 'user', text: 'three', files: [] },
    ],
  });
  assert.ok(hist.text.startsWith('Conversation so far:'));
});

test('buildPrompt: validation', () => {
  assert.throws(() => buildPrompt({ system: [], turns: [{ role: 'assistant', text: 'x', files: [] }] }), /last message must come from the user/);
  assert.throws(() => buildPrompt({ system: [], turns: [] }), /last message/);
  const f = { name: 'a.png', mime: 'image/png', data: Buffer.from('x') };
  const many = { system: [], turns: [{ role: 'user', text: 't', files: Array(MAX_FILES + 1).fill(f) }] };
  assert.throws(() => buildPrompt(many), /at most 10 files/);
  const ok = { system: [], turns: [{ role: 'user', text: 't', files: Array(MAX_FILES).fill(f) }] };
  assert.equal(buildPrompt(ok).files.length, MAX_FILES);
  assert.throws(() => buildPrompt({ system: [], turns: [{ role: 'user', text: '  ', files: [] }] }), /empty prompt/);
  assert.equal(buildPrompt({ system: [], turns: [{ role: 'user', text: '', files: [f] }] }).files.length, 1);
});

test('buildPrompt: JSON instruction appended with schema', () => {
  const schema = { type: 'object', required: ['a'] };
  const t = { system: [], turns: [{ role: 'user', text: 'give', files: [] }] };
  const plain = buildPrompt(t, { schema: null });
  assert.equal(plain.text, 'give' + jsonInstruction(null));
  assert.ok(!plain.text.includes('JSON Schema'));
  const withSchema = buildPrompt(t, { schema });
  assert.ok(withSchema.text.startsWith('give'));
  assert.ok(withSchema.text.endsWith(JSON.stringify(schema)));
  assert.match(withSchema.text, /only one valid JSON value/);
});

test('openAIJson / geminiJson', () => {
  assert.equal(openAIJson({}), null);
  assert.equal(openAIJson({ response_format: { type: 'text' } }), null);
  assert.deepEqual(openAIJson({ response_format: { type: 'json_object' } }), { schema: null });
  assert.deepEqual(openAIJson({ response_format: { type: 'json_schema', json_schema: { schema: { type: 'object' } } } }), { schema: { type: 'object' } });
  assert.deepEqual(openAIJson({ response_format: { type: 'json_schema' } }), { schema: null });
  assert.throws(() => openAIJson({ response_format: { type: 'xml' } }), /unsupported response_format/);

  assert.equal(geminiJson({}), null);
  assert.equal(geminiJson({ generationConfig: { temperature: 1 } }), null);
  assert.deepEqual(geminiJson({ generationConfig: { responseMimeType: 'application/json' } }), { schema: null });
  assert.deepEqual(geminiJson({ generation_config: { response_mime_type: 'application/json' } }), { schema: null });
  assert.deepEqual(geminiJson({ generationConfig: { responseSchema: { type: 'OBJECT' } } }), { schema: { type: 'OBJECT' } });
  assert.deepEqual(geminiJson({ generationConfig: { responseJsonSchema: { type: 'object' } } }), { schema: { type: 'object' } });
});

test('extractJson: plain, fenced, embedded', () => {
  assert.equal(extractJson(' {"a":1} '), '{"a":1}');
  assert.equal(extractJson('```json\n{"a": 2}\n```'), '{"a": 2}');
  assert.equal(extractJson('Sure!\n```\n[1,2]\n```\nbye'), '[1,2]');
  assert.equal(extractJson('Here you go: {"a":{"b":"}"}} thanks'), '{"a":{"b":"}"}}');
  assert.equal(extractJson('first {not json} then [1,2,3]'), '[1,2,3]');
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson(null), null);
  assert.equal(extractJson('{"unterminated": '), null);
});

test('checkSchema: types incl. Gemini upper-case', () => {
  assert.deepEqual(checkSchema({ a: 'x' }, { type: 'OBJECT', properties: { a: { type: 'STRING' } } }), []);
  assert.deepEqual(checkSchema({ a: 1 }, { type: 'OBJECT', properties: { a: { type: 'STRING' } } }), ['$.a: expected string, got integer']);
  assert.deepEqual(checkSchema(1.5, { type: 'integer' }), ['$: expected integer, got number']);
  assert.deepEqual(checkSchema(2, { type: 'number' }), []);
  assert.deepEqual(checkSchema(true, { type: 'boolean' }), []);
  assert.deepEqual(checkSchema([1], { type: 'object' }), ['$: expected object, got array']);
  assert.deepEqual(checkSchema('x', { type: ['string', 'null'] }), []);
  assert.deepEqual(checkSchema('x', null), []);
  assert.deepEqual(checkSchema('x', {}), []);
});

test('checkSchema: required, enum, nested arrays, nullable', () => {
  const schema = {
    type: 'object',
    required: ['name', 'tags'],
    properties: {
      name: { type: 'string', enum: ['a', 'b'] },
      tags: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } },
      note: { type: 'string', nullable: true },
      other: { type: ['string', 'null'] },
    },
  };
  assert.deepEqual(checkSchema({ name: 'a', tags: [{ id: 1 }], note: null, other: null }, schema), []);
  assert.deepEqual(checkSchema({ tags: [] }, schema), ['$.name: required']);
  assert.deepEqual(checkSchema({ name: 'c', tags: [] }, schema), ['$.name: not one of the allowed values']);
  assert.deepEqual(checkSchema({ name: 'a', tags: [{ id: 1 }, {}, { id: 'x' }] }, schema), [
    '$.tags[1].id: required',
    '$.tags[2].id: expected integer, got string',
  ]);
  assert.deepEqual(checkSchema({ name: null, tags: [] }, schema), ['$.name: null not allowed']);
  // errors capped at 20
  const many = checkSchema(Array(50).fill(1), { type: 'array', items: { type: 'string' } });
  assert.equal(many.length, 20);
});

test('judgeJson', () => {
  const schema = { type: 'object', required: ['a'] };
  assert.deepEqual(judgeJson('```json\n{"a":1}\n```', schema), { text: '{"a":1}', valid: true, errors: [] });
  assert.deepEqual(judgeJson('{"b":1}', schema), { text: '{"b":1}', valid: false, errors: ['$.a: required'] });
  assert.deepEqual(judgeJson('  just prose ', schema), { text: 'just prose', valid: false, errors: ['no JSON value found'] });
  assert.equal(judgeJson('[1]', null).valid, true);
});

test('thinking level from OpenAI and Gemini bodies', () => {
  assert.equal(openAIThinking({}), null);
  assert.equal(openAIThinking({ reasoning_effort: 'high' }), 'high');
  assert.equal(openAIThinking({ reasoning_effort: 'minimal' }), 'low');
  assert.equal(openAIThinking({ reasoning: { effort: 'medium' } }), 'medium');
  assert.throws(() => openAIThinking({ reasoning_effort: 'max' }), /unsupported/);
  assert.equal(geminiThinking({}), null);
  assert.equal(geminiThinking({ generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } } }), 'high');
  assert.equal(geminiThinking({ generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }), 'low');
  assert.equal(geminiThinking({ generationConfig: { thinkingConfig: { thinkingBudget: 8000 } } }), 'medium');
  assert.equal(geminiThinking({ generationConfig: { thinkingConfig: { thinkingBudget: 24576 } } }), 'high');
  assert.equal(geminiThinking({ generationConfig: { thinkingConfig: { thinkingBudget: -1 } } }), null);
});
