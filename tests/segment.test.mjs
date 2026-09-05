import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segment, TERMINATORS } from '../js/segment.js';

test('segment: empty/falsy input returns []', () => {
  assert.deepEqual(segment(''), []);
  assert.deepEqual(segment(null), []);
  assert.deepEqual(segment(undefined), []);
});

test('segment: splits English on terminal punctuation, keeping it', () => {
  assert.deepEqual(segment('Hello world. How are you? Fine!'), [
    'Hello world.',
    'How are you?',
    'Fine!',
  ]);
});

test('segment: splits Japanese on full-width terminators', () => {
  assert.deepEqual(segment('こんにちは。元気ですか？はい！'), [
    'こんにちは。',
    '元気ですか？',
    'はい！',
  ]);
});

test('segment: newline is a hard separator even without punctuation', () => {
  assert.deepEqual(segment('line one\nline two'), ['line one', 'line two']);
});

test('segment: trailing text without terminal punctuation is still kept', () => {
  assert.deepEqual(segment('Finished sentence. trailing fragment'), [
    'Finished sentence.',
    'trailing fragment',
  ]);
});

test('segment: blank lines are dropped', () => {
  assert.deepEqual(segment('a.\n\n\nb.'), ['a.', 'b.']);
});

test('segment: an abbreviation period followed by more text does not terminate (documented limitation)', () => {
  // "Mr. Smith" -- the period is followed by a space then more lowercase/uppercase text,
  // so the (?=\s|$) lookahead alone can't distinguish it from a real sentence end; this
  // documents the current (intentionally simple) behavior rather than asserting an ideal one.
  const result = segment('Mr. Smith went home.');
  assert.deepEqual(result, ['Mr.', 'Smith went home.']);
});

test('TERMINATORS: does not match a mid-word period (e.g. "1.5")', () => {
  TERMINATORS.lastIndex = 0;
  assert.equal(TERMINATORS.test('1.5'), false);
});
