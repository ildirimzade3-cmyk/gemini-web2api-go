import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canaryMatches, classifyUiMessage, normalizeWord, pickJsonText } from '../answer.mjs';

test('normalizeWord / canaryMatches ignore case and punctuation', () => {
  assert.equal(normalizeWord(' Pong. '), 'pong');
  assert.ok(canaryMatches('Pong!', 'pong'));
  assert.ok(canaryMatches('"pong"'));
  assert.ok(!canaryMatches('pong pong', 'pong'));
  assert.ok(!canaryMatches('', 'pong'));
  assert.ok(canaryMatches('PONG', 'Pong'));
});

test('classifyUiMessage: usage-limit texts in alerts and short answers are rate limits', () => {
  for (const t of [
    'You have reached your limit for today. Try again tomorrow.',
    "You've reached your usage limit",
    'Too many requests. Try again later.',
    'Please try again later',
    'Quota exceeded',
  ]) {
    assert.equal(classifyUiMessage(t, 'alert'), 'rate_limited', t);
  }
  assert.equal(classifyUiMessage("You've reached your limit on 3.1 Pro. Try again in 4 hours.", 'answer'), 'rate_limited');
  assert.equal(classifyUiMessage('Too many requests', 'answer'), 'rate_limited');
});

test('classifyUiMessage: a normal answer that merely mentions a limit is not a rate limit', () => {
  assert.equal(classifyUiMessage('The speed limit on this road is 50 km/h.', 'answer'), null);
  assert.equal(classifyUiMessage('Set a limit of 3 retries.', 'answer'), null);
  assert.equal(classifyUiMessage('pong', 'answer'), null);
  const long = "You've reached your limit. " + 'x'.repeat(500);
  assert.equal(classifyUiMessage(long, 'answer'), null, 'long answers are never classified');
  assert.equal(classifyUiMessage('', 'alert'), null);
});

test('classifyUiMessage: sign-in walls and failures', () => {
  assert.equal(classifyUiMessage('Sign in to continue using Gemini', 'alert'), 'sign_in_required');
  assert.equal(classifyUiMessage('Something went wrong. Please try again.', 'alert'), 'failure');
  assert.equal(classifyUiMessage('Sorry, something went wrong', 'answer'), 'failure');
});

test('pickJsonText prefers the longest code block that parses', () => {
  const r = pickJsonText('Here:\n```json\n{"a":1}\n```', ['{"a":1}', '{"a":1,"b":[1,2,3]}', 'not json']);
  assert.deepEqual(r, { text: '{"a":1,"b":[1,2,3]}', json_valid: true });
});

test('pickJsonText falls back to the whole text, a fenced text and an embedded object', () => {
  assert.deepEqual(pickJsonText('  {"a": 1}  ', []), { text: '{"a": 1}', json_valid: true });
  assert.deepEqual(pickJsonText('```json\n[1,2]\n```', []), { text: '[1,2]', json_valid: true });
  assert.deepEqual(pickJsonText('Sure! {"a":{"b":"}"}} Done.', []), { text: '{"a":{"b":"}"}}', json_valid: true });
});

test('pickJsonText reports invalid JSON and returns the text unchanged', () => {
  assert.deepEqual(pickJsonText('no json here {broken', ['also {broken']), { text: 'no json here {broken', json_valid: false });
  assert.deepEqual(pickJsonText('', []), { text: '', json_valid: false });
});
