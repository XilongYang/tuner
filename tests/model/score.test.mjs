// Reading an assessment: the bands, what a word is marked as, and what its
// popover says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accuracyLevel, overallScores, wordMark, wordHeadline, wordRange, ERROR_LABELS, LEGEND, GOOD_FROM, FAIR_FROM,
} from '../../js/model/score.js';

test('accuracyLevel: three bands, at their stated edges', () => {
  assert.equal(accuracyLevel(100), 'good');
  assert.equal(accuracyLevel(GOOD_FROM), 'good');
  assert.equal(accuracyLevel(GOOD_FROM - 1), 'mid');
  assert.equal(accuracyLevel(FAIR_FROM), 'mid');
  assert.equal(accuracyLevel(FAIR_FROM - 1), 'bad');
  assert.equal(accuracyLevel(0), 'bad');
});

test('accuracyLevel: the band is the band of the number that is shown', () => {
  // The service returns fractions. 79.5 is printed as "80" beside its colour,
  // and a chip reading 80 in the 60-79 band argues with the legend three lines
  // below it.
  assert.equal(accuracyLevel(79.5), 'good');
  assert.equal(accuracyLevel(59.5), 'mid');
  assert.deepEqual(overallScores({ overall: { pronunciation: 79.5 } })[0], { label: 'Overall', value: 80, level: 'good' });
  assert.equal(wordMark({ accuracy: 79.6, errorType: 'None' }).level, 'good');
  assert.match(wordHeadline({ word: 'fox', accuracy: 79.6, errorType: 'None' }), /accuracy 80/);
});

test('accuracyLevel: a missing score is the lowest band, not an error', () => {
  // A result with one unreadable number is still a result worth showing, and
  // drawing it as poor is honest about knowing nothing good.
  assert.equal(accuracyLevel(undefined), 'bad');
  assert.equal(accuracyLevel(null), 'bad');
  assert.equal(accuracyLevel(NaN), 'bad');
});

test('overallScores: four numbers, overall first, each with its band', () => {
  const scores = overallScores({ overall: { pronunciation: 87.4, accuracy: 90, fluency: 65, completeness: 40 } });

  assert.deepEqual(scores, [
    { label: 'Overall', value: 87, level: 'good' },
    { label: 'Accuracy', value: 90, level: 'good' },
    { label: 'Fluency', value: 65, level: 'mid' },
    { label: 'Completeness', value: 40, level: 'bad' },
  ]);
});

test('overallScores: an assessment missing its numbers still yields four of them', () => {
  assert.deepEqual(overallScores({}).map((score) => score.value), [0, 0, 0, 0]);
  assert.deepEqual(overallScores(null).map((score) => score.label),
    ['Overall', 'Accuracy', 'Fluency', 'Completeness']);
});

test('wordMark: a band for a spoken word', () => {
  assert.deepEqual(wordMark({ accuracy: 91, errorType: 'None' }), { error: null, level: 'good' });
  assert.deepEqual(wordMark({ accuracy: 42, errorType: 'Mispronunciation' }), { error: null, level: 'bad' });
});

test('wordMark: an omission and an insertion are not bands', () => {
  // One was never spoken and the other was never asked for, so neither has an
  // accuracy worth colouring.
  assert.deepEqual(wordMark({ accuracy: 0, errorType: 'Omission' }), { error: 'omission', level: null });
  assert.deepEqual(wordMark({ accuracy: 0, errorType: 'Insertion' }), { error: 'insertion', level: null });
});

test('wordHeadline: the word, its accuracy, and what went wrong', () => {
  assert.equal(wordHeadline({ word: 'fox', accuracy: 71.4, errorType: 'None' }), 'fox · accuracy 71');
  assert.equal(wordHeadline({ word: 'fox', accuracy: 40, errorType: 'Mispronunciation' }),
    'fox · accuracy 40 · mispronounced');
});

test('wordHeadline: an omission and an insertion say what they are instead', () => {
  assert.match(wordHeadline({ word: 'the', errorType: 'Omission' }), /the · omission · in the reference but not spoken/);
  assert.match(wordHeadline({ word: 'er', errorType: 'Insertion' }), /er · insertion · spoken but not in the reference/);
});

test('wordHeadline: a retest keeps the word\'s own name and says it is a retest', () => {
  // The service returns what it heard, which for a retest of "fox" may be
  // "box" -- and a popover that renamed the word would be claiming the
  // sentence had changed.
  const heard = { word: 'box', accuracy: 88, errorType: 'None' };
  assert.equal(wordHeadline(heard, { name: 'fox', prefix: 'Retest: ' }), 'Retest: fox · accuracy 88');
});

test('wordHeadline: an unknown error type is left out rather than printed raw', () => {
  assert.equal(wordHeadline({ word: 'fox', accuracy: 80, errorType: 'SomethingNew' }), 'fox · accuracy 80');
  assert.equal(ERROR_LABELS.None, '');
});

test('wordRange: where the word was heard, or nothing', () => {
  assert.deepEqual(wordRange({ offsetMs: 400, durationMs: 300 }), { offsetMs: 400, durationMs: 300 });
  assert.equal(wordRange({ offsetMs: 400, durationMs: 0 }), null, 'a zero-length span is nothing to play');
  assert.equal(wordRange({ offsetMs: null, durationMs: 300 }), null);
  assert.equal(wordRange({ errorType: 'Omission' }), null, 'an omission has no audio at all');
  assert.equal(wordRange(undefined), null);
});

test('the legend covers every mark a word can carry', () => {
  const marks = new Set(LEGEND.map((item) => item.level || item.error));
  for (const mark of ['good', 'mid', 'bad', 'omission', 'insertion']) {
    assert.ok(marks.has(mark), `the legend explains ${mark}`);
  }
});

test('the legend\'s numbers are the bands themselves, not a second copy of them', () => {
  assert.match(LEGEND[0].label, new RegExp(String(GOOD_FROM)));
  assert.match(LEGEND[1].label, new RegExp(`${FAIR_FROM}–${GOOD_FROM - 1}`));
});
