import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SELECTORS, SelectorBook, classifyMessage, labelsMatch, parseModelItems } from '../src/ui.mjs';

test('classifyMessage: challenge, signed_out, limit, failure', () => {
  assert.equal(classifyMessage('Our systems have detected unusual traffic from your network'), 'challenge');
  assert.equal(classifyMessage('Please verify it is you'), null);
  assert.equal(classifyMessage('Please verify it\'s you to continue'), 'challenge');
  assert.equal(classifyMessage('Your account has been suspended'), 'challenge');
  assert.equal(classifyMessage('Please sign in to continue'), 'signed_out');
  assert.equal(classifyMessage('Your session has expired'), 'signed_out');
  assert.equal(classifyMessage("You've reached your daily limit for Pro"), 'limit');
  assert.equal(classifyMessage('You have reached the Thinking limit'), 'limit');
  assert.equal(classifyMessage('Too many requests, try again later'), 'limit');
  assert.equal(classifyMessage('Sorry, something went wrong'), 'failure');
  assert.equal(classifyMessage('Something went wrong. Please try again.'), 'failure');
});

test('classifyMessage: model_switch needs a model word', () => {
  assert.equal(classifyMessage('We switched you to Flash because of high demand'), 'model_switch');
  assert.equal(classifyMessage('Responses will use the lite model'), 'model_switch');
  assert.equal(classifyMessage('We switched you to the next page'), null);
  assert.equal(classifyMessage('Falling back to the default'), null);
});

test('classifyMessage: long answer text ignored only for source answer', () => {
  const long = 'This explains unusual traffic patterns on networks. '.repeat(12);
  assert.ok(long.length > 400);
  assert.equal(classifyMessage(long, 'answer'), null);
  assert.equal(classifyMessage(long, 'alert'), 'challenge');
  assert.equal(classifyMessage('x'.repeat(400) + ' unusual traffic', 'answer'), null);
  assert.equal(classifyMessage('The unusual traffic essay is short', 'answer'), 'challenge');
});

test('classifyMessage: normal text and empty -> null', () => {
  assert.equal(classifyMessage('Here is your recipe for pancakes.'), null);
  assert.equal(classifyMessage(''), null);
  assert.equal(classifyMessage(null), null);
  assert.equal(classifyMessage('   '), null);
});

test('parseModelItems: dedupe, label/description split, disabled', () => {
  const items = parseModelItems([
    { text: '3.1 Pro\n  Best for\ncomplex tasks ', id: 'bard-mode-option-pro', selected: true },
    { text: '3.1 PRO\nduplicate' },
    { text: 'Flash\nFast  and   light', enabled: false },
    { text: '   ' },
    { text: '\n\nThinking' },
    null,
  ]);
  assert.deepEqual(items, [
    { index: 0, label: '3.1 Pro', description: 'Best for complex tasks', id: 'bard-mode-option-pro', enabled: true, selected: true },
    { index: 2, label: 'Flash', description: 'Fast and light', id: '', enabled: false, selected: false },
    { index: 4, label: 'Thinking', description: '', id: '', enabled: true, selected: false },
  ]);
  assert.deepEqual(parseModelItems(undefined), []);
  assert.deepEqual(parseModelItems('x'), []);
});

test('labelsMatch', () => {
  assert.equal(labelsMatch('3.1 Pro', '3.1 pro'), true);
  assert.equal(labelsMatch('Pro', '3.1 Pro'), true);
  assert.equal(labelsMatch('Gemini 3.1 Pro', '3.1 Pro'), true);
  assert.equal(labelsMatch('Flash', '3.1 Pro'), false);
  assert.equal(labelsMatch('', '3.1 Pro'), false);
  assert.equal(labelsMatch('Pro', ''), false);
  assert.equal(labelsMatch('  3.1   Pro ', '3.1 Pro'), true);
});

test('SelectorBook: learned first, max 3, onChange called', () => {
  const changes = [];
  const book = new SelectorBook({}, (l) => changes.push(structuredClone(l)));
  assert.deepEqual(book.list('input'), DEFAULT_SELECTORS.input);
  assert.deepEqual(book.list('nonexistent'), []);

  book.learn('input', 'div.new');
  assert.equal(book.list('input')[0], 'div.new');
  assert.equal(book.list('input').length, DEFAULT_SELECTORS.input.length + 1);
  assert.equal(changes.length, 1);

  // learning the current first selector again is a no-op
  book.learn('input', 'div.new');
  assert.equal(changes.length, 1);
  book.learn('input', '');
  assert.equal(changes.length, 1);

  book.learn('input', 'a');
  book.learn('input', 'b');
  book.learn('input', 'c');
  assert.deepEqual(book.learned.input, ['c', 'b', 'a']);
  assert.equal(changes.length, 4);
  assert.deepEqual(book.list('input').slice(0, 3), ['c', 'b', 'a']);

  // a learned default is not listed twice
  const d = DEFAULT_SELECTORS.send[1];
  book.learn('send', d);
  const list = book.list('send');
  assert.equal(list[0], d);
  assert.equal(list.filter((s) => s === d).length, 1);
  assert.equal(list.length, DEFAULT_SELECTORS.send.length);
});

test('SelectorBook does not share state with the object it was built from', () => {
  const seed = { input: ['x'] };
  const book = new SelectorBook(seed);
  book.learn('input', 'y');
  assert.deepEqual(seed, { input: ['x'] });
  assert.deepEqual(book.list('input').slice(0, 2), ['y', 'x']);
});
