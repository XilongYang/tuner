import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSessionLocked, textSplitPoints, splitPointers, splitText, isSplittable,
  partitionWords, partitionManualPoints, splitRange, mergeRanges, mergeWords, mergeSeams,
} from '../../js/model/geometry.js';

const word = (charStart, charEnd, offsetMs, durationMs) => ({ charStart, charEnd, offsetMs, durationMs });

test('isSessionLocked: audio always locks; auto locks only once split', () => {
  assert.equal(isSessionLocked('audio', 0), true);
  assert.equal(isSessionLocked('audio', 3), true);
  assert.equal(isSessionLocked('auto', 0), false);
  assert.equal(isSessionLocked('auto', 1), true);
});

test('textSplitPoints: every interior position of unspaced text, never an end, ms always null', () => {
  const points = textSplitPoints('あいうえ');
  assert.deepEqual(points.map((p) => p.charIndex), [1, 2, 3]);
  assert.ok(points.every((p) => p.ms === null && p.kind === 'text'));
  assert.deepEqual(textSplitPoints('あ'), []);
  assert.deepEqual(textSplitPoints(''), []);
});

test('textSplitPoints: English is cut between words, not between letters', () => {
  assert.deepEqual(textSplitPoints('Alpha beta gamma.').map((p) => p.charIndex), [6, 11]);
  assert.deepEqual(textSplitPoints('Word').map((p) => p.charIndex), []);
});

test('textSplitPoints: a mixed sentence offers word starts and kana positions together', () => {
  // Around PDF, never inside it; every kana gap as usual.
  assert.deepEqual(textSplitPoints('この PDF を読む').map((p) => p.charIndex), [1, 3, 7, 8, 9]);
});

test('textSplitPoints: counts code points, so an astral character is one position', () => {
  // '𠮟' is a surrogate pair: 2 UTF-16 units, 1 code point.
  assert.deepEqual(textSplitPoints('𠮟る').map((p) => p.charIndex), [1]);
});

test('splitPointers: real word boundaries carry their timestamp; sentence ends are dropped', () => {
  const sentence = { text: 'one two', words: [word(0, 3, 500, 200), word(4, 7, 900, 300)] };
  assert.deepEqual(splitPointers(sentence), [{ charIndex: 4, ms: 900, kind: 'word' }]);
});

test('splitPointers: a word starting at 0ms keeps 0, not null -- 0 is a real timestamp', () => {
  const sentence = { text: 'ab cd', words: [word(0, 2, 0, 100), word(3, 5, 0, 100)] };
  assert.deepEqual(splitPointers(sentence), [{ charIndex: 3, ms: 0, kind: 'word' }]);
});

test('splitPointers: manual points are offered alongside words, sorted together', () => {
  const sentence = {
    text: 'one two three',
    words: [word(0, 3, 100, 50), word(8, 13, 700, 50)],
    manualPoints: [{ charIndex: 4, offsetMs: 400 }],
  };
  assert.deepEqual(splitPointers(sentence), [
    { charIndex: 4, ms: 400, kind: 'manual' },
    { charIndex: 8, ms: 700, kind: 'word' },
  ]);
});

test('splitPointers: no timing data at all falls back to text points with null ms', () => {
  const points = splitPointers({ text: 'あいう', words: null, manualPoints: null });
  assert.deepEqual(points, [
    { charIndex: 1, ms: null, kind: 'text' },
    { charIndex: 2, ms: null, kind: 'text' },
  ]);
});

test('splitPointers: an empty words array is the same as none -- still falls back', () => {
  const points = splitPointers({ text: 'あい', words: [], manualPoints: [] });
  assert.deepEqual(points, [{ charIndex: 1, ms: null, kind: 'text' }]);
});

test('splitText: whitespace at the cut stays on the left, so split-then-merge is lossless', () => {
  assert.deepEqual(splitText('Alpha beta', 6), { left: 'Alpha ', right: 'beta' });
  // Rejoining with no separator (which is what merge does) gives the original back.
  const { left, right } = splitText('Alpha beta', 6);
  assert.equal(left + right, 'Alpha beta');
});

test('isSplittable: rejects a cut that leaves a whitespace-only half', () => {
  assert.equal(isSplittable('Alpha beta', 6), true);
  assert.equal(isSplittable(' beta', 1), false);
  assert.equal(isSplittable('alpha ', 5), false);
});

test('partitionWords: right side is re-based onto its own new text', () => {
  const words = [word(0, 3, 100, 50), word(4, 7, 200, 50)];
  assert.deepEqual(partitionWords(words, 4), {
    left: [word(0, 3, 100, 50)],
    right: [word(0, 3, 200, 50)],
  });
});

test('partitionWords: a word straddling the cut is dropped rather than guessed at', () => {
  assert.deepEqual(partitionWords([word(2, 8, 100, 50)], 5), { left: [], right: [] });
});

test('partitionManualPoints: the cut position itself is consumed, the rest re-based', () => {
  const points = [{ charIndex: 2, offsetMs: 10 }, { charIndex: 5, offsetMs: 20 }, { charIndex: 9, offsetMs: 30 }];
  assert.deepEqual(partitionManualPoints(points, 5), {
    left: [{ charIndex: 2, offsetMs: 10 }],
    right: [{ charIndex: 4, offsetMs: 30 }],
  });
});

test('splitRange: divides a range, both halves on the original timeline', () => {
  assert.deepEqual(splitRange({ offsetMs: 1000, durationMs: 800 }, 1300), {
    left: { offsetMs: 1000, durationMs: 300 },
    right: { offsetMs: 1300, durationMs: 500 },
  });
});

test('splitRange: a null timestamp yields null -- the case a coerced 0 used to hide', () => {
  // Regression guard. A cut position with no timing data reaches here as null;
  // reading it off the DOM used to produce Number('') === 0, which sailed
  // through the arithmetic below and silently produced empty clips.
  assert.equal(splitRange({ offsetMs: 1000, durationMs: 800 }, null), null);
  assert.equal(splitRange({ offsetMs: 1000, durationMs: 800 }, undefined), null);
  assert.equal(splitRange({ offsetMs: 1000, durationMs: 800 }, NaN), null);
});

test('splitRange: 0 is honoured as a real timestamp, and rejected only for being out of range', () => {
  // A range that genuinely starts at 0 can't be split AT 0 (empty left half),
  // but one that starts before it can be -- proving 0 is not being treated as
  // "missing".
  assert.equal(splitRange({ offsetMs: 0, durationMs: 500 }, 0), null);
  assert.deepEqual(splitRange({ offsetMs: -200, durationMs: 500 }, 0), {
    left: { offsetMs: -200, durationMs: 200 },
    right: { offsetMs: 0, durationMs: 300 },
  });
});

test('splitRange: a cut outside the range yields null rather than a negative duration', () => {
  assert.equal(splitRange({ offsetMs: 1000, durationMs: 500 }, 900), null);
  assert.equal(splitRange({ offsetMs: 1000, durationMs: 500 }, 1500), null);
  assert.equal(splitRange({ offsetMs: 1000, durationMs: 500 }, 1600), null);
});

test('splitRange: a missing or malformed range yields null', () => {
  assert.equal(splitRange(null, 100), null);
  assert.equal(splitRange({ offsetMs: null, durationMs: 500 }, 100), null);
  assert.equal(splitRange({ offsetMs: 0, durationMs: null }, 100), null);
});

test('mergeRanges: spans the whole run', () => {
  assert.deepEqual(mergeRanges([
    { offsetMs: 100, durationMs: 200 },
    { offsetMs: 300, durationMs: 150 },
  ]), { offsetMs: 100, durationMs: 350 });
});

test('mergeRanges: one missing range means no result at all, not a partial one', () => {
  assert.equal(mergeRanges([{ offsetMs: 100, durationMs: 200 }, null]), null);
  assert.equal(mergeRanges([]), null);
});

test('mergeWords: re-bases each list by the total length of the texts before it', () => {
  const merged = mergeWords(
    [[word(0, 3, 100, 50)], [word(0, 4, 300, 50)]],
    ['one', 'four'],
  );
  assert.deepEqual(merged, [word(0, 3, 100, 50), word(3, 7, 300, 50)]);
});

test('mergeWords: any sentence without words yields null -- partial timings misplace later words', () => {
  assert.equal(mergeWords([[word(0, 3, 100, 50)], []], ['one', 'two']), null);
  assert.equal(mergeWords([[word(0, 3, 100, 50)]], ['one', 'two']), null);
});

test('mergeSeams: a seam per join, timestamped from the following range when known', () => {
  assert.deepEqual(
    mergeSeams(['one', 'four', 'x'], [
      { offsetMs: 100, durationMs: 50 },
      { offsetMs: 300, durationMs: 50 },
      { offsetMs: 500, durationMs: 50 },
    ]),
    [{ charIndex: 3, offsetMs: 300 }, { charIndex: 7, offsetMs: 500 }],
  );
});

test('mergeSeams: a seam with no range is still a usable text cut, explicitly not an audio claim', () => {
  assert.deepEqual(mergeSeams(['ab', 'cd'], [null, null]), [{ charIndex: 2, offsetMs: null }]);
  assert.deepEqual(mergeSeams(['ab', 'cd']), [{ charIndex: 2, offsetMs: null }]);
});
