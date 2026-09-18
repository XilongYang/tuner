import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordUnitsForSentence, groupContiguousSelection } from '../js/sentence-panel/vocab-picker-geometry.js';

test('wordUnitsForSentence: uses real sentence.words verbatim when present', () => {
  const words = [{ charStart: 0, charEnd: 5, offsetMilliseconds: 0, durationMilliseconds: 100 }];
  const sentence = { text: 'hello world', lang: 'en', words };
  assert.equal(wordUnitsForSentence(sentence), words);
});

test('wordUnitsForSentence: English fallback splits on whitespace runs into word spans', () => {
  const sentence = { text: 'hello   world again', lang: 'en', words: null };
  const units = wordUnitsForSentence(sentence);
  const chars = Array.from(sentence.text);
  assert.deepEqual(units.map((u) => chars.slice(u.charStart, u.charEnd).join('')), ['hello', 'world', 'again']);
});

test('wordUnitsForSentence: Japanese fallback splits every non-whitespace character into its own unit', () => {
  const sentence = { text: 'おはよう', lang: 'ja', words: [] };
  const units = wordUnitsForSentence(sentence);
  const chars = Array.from(sentence.text);
  assert.deepEqual(units.map((u) => chars.slice(u.charStart, u.charEnd).join('')), ['お', 'は', 'よ', 'う']);
});

test('groupContiguousSelection: consecutive indices merge into one group; a gap starts a new one', () => {
  const units = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const groups = groupContiguousSelection(new Set([0, 1, 3]), units);
  assert.deepEqual(groups, [[units[0], units[1]], [units[3]]]);
});

test('groupContiguousSelection: order of the input Set does not matter -- output is always ascending', () => {
  const units = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const groups = groupContiguousSelection(new Set([2, 0, 1]), units);
  assert.deepEqual(groups, [[units[0], units[1], units[2]]]);
});

test('groupContiguousSelection: empty selection yields no groups', () => {
  assert.deepEqual(groupContiguousSelection(new Set(), [{ id: 'a' }]), []);
});
