import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sentenceById, indexOfSentence, blankSentence, updateSentence, updateSession,
  splitSentence, mergeSentences, canMerge, derivedInputText, sessionLabel, mergeSelectable
, setOnEverySentence, isWorthStoring} from '../../js/model/session.js';

const sentence = (id, text, over = {}) => blankSentence({ id, text, lang: 'en', now: 10, ...over });

const session = (sentences, over = {}) => ({
  id: 'sess1', name: null, folderId: null, splitMode: 'auto',
  createdAt: 1, updatedAt: 10, metaUpdatedAt: 10,
  inputText: null, inputTextHash: null, sourceAudio: null, sourceAudioHash: null,
  sentences, ...over,
});

const word = (charStart, charEnd, offsetMs, durationMs) => ({ charStart, charEnd, offsetMs, durationMs });

test('sentenceById / indexOfSentence: find a sentence, or report its absence', () => {
  const s = session([sentence('a', 'one'), sentence('b', 'two')]);
  assert.equal(sentenceById(s, 'b').text, 'two');
  assert.equal(indexOfSentence(s, 'b'), 1);
  assert.equal(sentenceById(s, 'gone'), null);
  assert.equal(indexOfSentence(s, 'gone'), -1);
});

test('updateSentence: patches the named sentence and moves the session clock', () => {
  const before = session([sentence('a', 'one'), sentence('b', 'two')]);
  const after = updateSentence(before, 'b', { hidden: true }, 500);

  assert.equal(after.sentences[1].hidden, true);
  assert.equal(after.sentences[1].updatedAt, 500);
  assert.equal(after.updatedAt, 500);
  assert.equal(after.metaUpdatedAt, 10, 'the session\'s own fields did not change');
});

test('updateSentence: a sentence that is gone is a no-op, not an error or a mis-targeted write', () => {
  // The stale-caller case: scoring finished for a sentence that a split
  // replaced while the request was in flight.
  const before = session([sentence('a', 'one')]);
  const after = updateSentence(before, 'replaced-long-ago', { assessment: { score: 90 } }, 500);
  assert.equal(after, before);
});

test('updateSentence: does not mutate the session it was given', () => {
  const before = session([sentence('a', 'one')]);
  const snapshot = JSON.stringify(before);
  updateSentence(before, 'a', { hidden: true }, 500);
  assert.equal(JSON.stringify(before), snapshot);
});

test('updateSession: moves both clocks, because the session\'s own fields changed', () => {
  const after = updateSession(session([]), { name: 'Lesson 3' }, 700);
  assert.equal(after.name, 'Lesson 3');
  assert.equal(after.updatedAt, 700);
  assert.equal(after.metaUpdatedAt, 700);
});

test('splitSentence: replaces one sentence with two, in place', () => {
  const before = session([sentence('a', 'one'), sentence('b', 'Alpha beta'), sentence('c', 'three')]);
  const result = splitSentence(before, { sentenceId: 'b', charIndex: 6, leftId: 'L', rightId: 'R', now: 500 });

  assert.deepEqual(result.session.sentences.map((s) => s.id), ['a', 'L', 'R', 'c']);
  assert.deepEqual(result.session.sentences.slice(1, 3).map((s) => s.text), ['Alpha ', 'beta']);
  assert.deepEqual(result.replacedIds, ['b']);
  assert.deepEqual(result.added, ['L', 'R']);
});

test('splitSentence: rejoining the halves gives back the original text exactly', () => {
  const result = splitSentence(session([sentence('a', 'Alpha beta')]), { sentenceId: 'a', charIndex: 6, leftId: 'L', rightId: 'R', now: 1 });
  assert.equal(result.session.sentences.map((s) => s.text).join(''), 'Alpha beta');
});

test('splitSentence: word timings follow the half that kept the audio, re-based', () => {
  const before = session([sentence('a', 'one two', {
    words: [word(0, 3, 100, 50), word(4, 7, 200, 50)],
  })]);
  const { session: after } = splitSentence(before, {
    sentenceId: 'a',
    charIndex: 4,
    leftId: 'L',
    rightId: 'R',
    now: 1,
    left: { reference: 'LEFT-CLIP' },
    right: { reference: 'RIGHT-CLIP' },
  });

  assert.deepEqual(after.sentences[0].words, [word(0, 3, 100, 50)]);
  assert.deepEqual(after.sentences[1].words, [word(0, 3, 200, 50)]);
});

test('splitSentence: a half with no audio keeps no timings either', () => {
  // Its cut markers would otherwise claim exact timestamps into a clip the half
  // does not have -- and after a plain text split, neither half has one.
  const before = session([sentence('a', 'one two', {
    words: [word(0, 3, 100, 50), word(4, 7, 200, 50)],
  })]);

  const { session: after } = splitSentence(before, { sentenceId: 'a', charIndex: 4, leftId: 'L', rightId: 'R', now: 1 });

  assert.equal(after.sentences[0].words, null);
  assert.equal(after.sentences[1].words, null);
});

test('splitSentence: each half keeps the audio the caller cut for it', () => {
  const before = session([sentence('a', 'Alpha beta', { referenceSource: 'import', sourceOffsetMs: 1000, sourceDurationMs: 800 })]);
  const { session: after } = splitSentence(before, {
    sentenceId: 'a', charIndex: 6, leftId: 'L', rightId: 'R', now: 1,
    left: { reference: 'LEFT_CLIP', referenceHash: 'lh', range: { offsetMs: 1000, durationMs: 300 } },
    right: { reference: 'RIGHT_CLIP', referenceHash: 'rh', range: { offsetMs: 1300, durationMs: 500 } },
  });

  assert.equal(after.sentences[0].reference, 'LEFT_CLIP');
  assert.equal(after.sentences[0].referenceHash, 'lh');
  assert.equal(after.sentences[0].sourceOffsetMs, 1000);
  assert.equal(after.sentences[1].sourceDurationMs, 500);
  assert.equal(after.sentences[1].referenceSource, 'import');
});

test('splitSentence: a half with no audio claims none -- no hash, no source markers', () => {
  // The caller could not cut the clip (no timestamp at this position). The text
  // split still happens; what must not happen is a record claiming a clip that
  // does not exist.
  const before = session([sentence('a', 'Alpha beta', { referenceSource: 'import', sourceOffsetMs: 1000, sourceDurationMs: 800 })]);
  const { session: after } = splitSentence(before, { sentenceId: 'a', charIndex: 6, leftId: 'L', rightId: 'R', now: 1 });

  for (const half of after.sentences) {
    assert.equal(half.reference, null);
    assert.equal(half.referenceHash, null);
    assert.equal(half.referenceSource, null);
    assert.equal(half.sourceOffsetMs, null);
    assert.equal(half.sourceDurationMs, null);
  }
});

test('splitSentence: a cut leaving a whitespace-only half is refused', () => {
  assert.equal(splitSentence(session([sentence('a', ' beta')]), { sentenceId: 'a', charIndex: 1, leftId: 'L', rightId: 'R', now: 1 }), null);
});

test('splitSentence: a sentence that is no longer there is refused rather than mis-targeted', () => {
  assert.equal(splitSentence(session([sentence('a', 'one two')]), { sentenceId: 'gone', charIndex: 3, leftId: 'L', rightId: 'R', now: 1 }), null);
});

test('splitSentence: the halves inherit hidden, so a masked sentence stays masked', () => {
  const before = session([sentence('a', 'one two', { hidden: true })]);
  const { session: after } = splitSentence(before, { sentenceId: 'a', charIndex: 4, leftId: 'L', rightId: 'R', now: 1 });
  assert.deepEqual(after.sentences.map((s) => s.hidden), [true, true]);
});

test('mergeSentences: joins a run into one, adding nothing where the seam already has its space', () => {
  const before = session([sentence('a', 'one'), sentence('b', 'Alpha '), sentence('c', 'beta'), sentence('d', 'four')]);
  const result = mergeSentences(before, { sentenceIds: ['b', 'c'], newId: 'M', now: 500 });

  assert.deepEqual(result.session.sentences.map((s) => s.id), ['a', 'M', 'd']);
  assert.equal(result.session.sentences[1].text, 'Alpha beta');
  assert.deepEqual(result.replacedIds, ['b', 'c']);
});

test('mergeSentences: two segmented English sentences get back the space segmentation trimmed', () => {
  // Without it the result is "One sentence.Two sentences." -- text nobody wrote,
  // and text that then gets read aloud and scored in that state.
  const before = session([sentence('a', 'One sentence.'), sentence('b', 'Two sentences.')]);
  const { session: after } = mergeSentences(before, { sentenceIds: ['a', 'b'], newId: 'M', now: 1 });
  assert.equal(after.sentences[0].text, 'One sentence. Two sentences.');
});

test('mergeSentences: Japanese is joined with nothing, because that is how it is written', () => {
  const before = session([sentence('a', '今日はいい天気ですね。'), sentence('b', '散歩に行きましょう。')]);
  const { session: after } = mergeSentences(before, { sentenceIds: ['a', 'b'], newId: 'M', now: 1 });
  assert.equal(after.sentences[0].text, '今日はいい天気ですね。散歩に行きましょう。');
});

test('mergeSentences: an inserted separator shifts the words past it', () => {
  const before = session([
    sentence('a', 'One.', { words: [word(0, 4, 100, 50)], sourceOffsetMs: 100, sourceDurationMs: 100 }),
    sentence('b', 'Two.', { words: [word(0, 4, 300, 50)], sourceOffsetMs: 300, sourceDurationMs: 100 }),
  ]);
  const { session: after } = mergeSentences(before, { sentenceIds: ['a', 'b'], newId: 'M', now: 1, reference: 'CLIP' });

  assert.equal(after.sentences[0].text, 'One. Two.');
  assert.deepEqual(after.sentences[0].words, [word(0, 4, 100, 50), word(5, 9, 300, 50)],
    'the second piece starts after the separator, so splitting there leaves the space on the left');
});

test('mergeSentences: splitting where the join was gives the pieces back', () => {
  const before = session([sentence('a', 'One.'), sentence('b', 'Two.')]);
  const merged = mergeSentences(before, { sentenceIds: ['a', 'b'], newId: 'M', now: 1 }).session;
  // Nothing records the join: the position is offered like any other, as the
  // start of the second piece's first word.
  const seam = merged.sentences[0].text.indexOf('Two.');

  const split = splitSentence(merged, { sentenceId: 'M', charIndex: seam, leftId: 'L', rightId: 'R', now: 2 });
  assert.deepEqual(split.session.sentences.map((s) => s.text), ['One. ', 'Two.'],
    'the separator goes with the left half, exactly as a split always leaves whitespace');
});

test('mergeSentences: split then merge restores the original text exactly', () => {
  const original = 'Alpha beta';
  const split = splitSentence(session([sentence('a', original)]), { sentenceId: 'a', charIndex: 6, leftId: 'L', rightId: 'R', now: 1 });
  const merged = mergeSentences(split.session, { sentenceIds: ['L', 'R'], newId: 'M', now: 2 });
  assert.equal(merged.session.sentences[0].text, original);
});

test('mergeSentences: the join leaves no mark of its own', () => {
  // A merged sentence is one sentence. Where it was joined is offered like any
  // other cut position -- by its words when it kept a clip, by the text when it
  // did not -- and a mark of its own only meant the same position twice, in a
  // second colour, long after the case it was added for.
  const before = session([
    sentence('a', 'one ', { sourceOffsetMs: 0, sourceDurationMs: 400 }),
    sentence('b', 'two', { sourceOffsetMs: 500, sourceDurationMs: 300 }),
  ]);

  const { session: after } = mergeSentences(before, { sentenceIds: ['a', 'b'], newId: 'M', now: 1, reference: 'CLIP' });

  assert.deepEqual(Object.keys(after.sentences[0]).filter((k) => /manual|seam/i.test(k)), [],
    'the merged sentence carries no record of the join (where it can be cut is geometry.js\'s answer)');
});

test('mergeSentences: word timings are re-based onto the joined text, when the clip is kept', () => {
  const before = session([
    sentence('a', 'one ', { words: [word(0, 3, 100, 50)] }),
    sentence('b', 'two', { words: [word(0, 3, 300, 50)] }),
  ]);
  const { session: after } = mergeSentences(before, { sentenceIds: ['a', 'b'], newId: 'M', now: 1, reference: 'CLIP' });
  assert.deepEqual(after.sentences[0].words, [word(0, 3, 100, 50), word(4, 7, 300, 50)]);
});

test('mergeSentences: with no clip kept, the timings go too -- they describe audio this sentence lacks', () => {
  // Each piece's timings were measured against its own reading, both starting
  // at zero. Carried onto a sentence with no clip they produce exact-looking
  // cut markers at times that belong to audio it does not have.
  const before = session([
    sentence('a', 'Alpha beta.', { words: [word(0, 5, 0, 400), word(6, 10, 500, 400)] }),
    sentence('b', 'Gamma delta.', { words: [word(0, 5, 0, 400), word(6, 11, 500, 400)] }),
  ]);

  const { session: after } = mergeSentences(before, { sentenceIds: ['a', 'b'], newId: 'M', now: 1 });

  assert.equal(after.sentences[0].words, null);
  assert.equal(after.sentences[0].reference, null);
});

test('mergeSentences: ids given out of order still merge the run correctly', () => {
  const before = session([sentence('a', 'one'), sentence('b', 'two'), sentence('c', 'three')]);
  const { session: after } = mergeSentences(before, { sentenceIds: ['c', 'b'], newId: 'M', now: 1 });
  assert.deepEqual(after.sentences.map((s) => s.id), ['a', 'M']);
  assert.equal(after.sentences[1].text, 'two three');
});

test('mergeSentences: non-adjacent sentences are refused', () => {
  const before = session([sentence('a', 'one'), sentence('b', 'two'), sentence('c', 'three')]);
  assert.equal(mergeSentences(before, { sentenceIds: ['a', 'c'], newId: 'M', now: 1 }), null);
});

test('mergeSentences: fewer than two, or a missing id, is refused', () => {
  const before = session([sentence('a', 'one'), sentence('b', 'two')]);
  assert.equal(mergeSentences(before, { sentenceIds: ['a'], newId: 'M', now: 1 }), null);
  assert.equal(mergeSentences(before, { sentenceIds: ['a', 'gone'], newId: 'M', now: 1 }), null);
  assert.equal(mergeSentences(before, { sentenceIds: [], newId: 'M', now: 1 }), null);
});

test('mergeSentences: the result is hidden only if every part was', () => {
  const before = session([sentence('a', 'one', { hidden: true }), sentence('b', 'two', { hidden: false })]);
  const { session: after } = mergeSentences(before, { sentenceIds: ['a', 'b'], newId: 'M', now: 1 });
  assert.equal(after.sentences[0].hidden, false);
});

test('canMerge: agrees with what mergeSentences will accept', () => {
  const s = session([sentence('a', 'one'), sentence('b', 'two'), sentence('c', 'three')]);
  assert.equal(canMerge(s, ['a', 'b']), true);
  assert.equal(canMerge(s, ['b', 'a']), true);
  assert.equal(canMerge(s, ['a', 'c']), false);
  assert.equal(canMerge(s, ['a']), false);
  assert.equal(canMerge(s, ['a', 'gone']), false);
});

test('derivedInputText: a typed session keeps what was typed', () => {
  assert.equal(derivedInputText(session([sentence('a', 'edited')], { inputText: 'as typed' })), 'as typed');
});

test('derivedInputText: an audio session derives it from the sentences, so the two cannot drift', () => {
  const s = session([sentence('a', 'first'), sentence('b', 'second')], { splitMode: 'audio', inputText: 'stale transcript' });
  assert.equal(derivedInputText(s), 'first\nsecond');
});

test('sessionLabel: prefers the name, else the opening words, else Untitled', () => {
  assert.equal(sessionLabel(session([], { name: 'Lesson 3' })), 'Lesson 3');
  assert.equal(sessionLabel(session([sentence('a', 'Hello there')])), 'Hello there');
  assert.equal(sessionLabel(session([])), 'Untitled');
});

test('sessionLabel: truncates by code point, so an astral character is never cut in half', () => {
  const label = sessionLabel(session([sentence('a', '𠮟'.repeat(30))]), 5);
  assert.equal(label, `${'𠮟'.repeat(5)}…`);
});

test('mergeSelectable: with nothing selected, any sentence can start a run', () => {
  const s = threeSentenceSession();
  assert.deepEqual([...mergeSelectable(s, [])], ['s1', 's2', 's3']);
  assert.deepEqual([...mergeSelectable(s, null)], ['s1', 's2', 's3']);
});

test('mergeSelectable: a selected run offers its neighbours and its own ends', () => {
  const s = threeSentenceSession();
  assert.deepEqual([...mergeSelectable(s, ['s2'])].sort(), ['s1', 's2', 's3']);
  assert.deepEqual([...mergeSelectable(s, ['s1'])].sort(), ['s1', 's2'], 'nothing before the first');
});

test('mergeSelectable: the middle of a run is not offered -- dropping it would leave a hole', () => {
  const s = threeSentenceSession();
  assert.deepEqual([...mergeSelectable(s, ['s1', 's2', 's3'])].sort(), ['s1', 's3']);
});

test('mergeSelectable: ids that are no longer in the session do not widen the run', () => {
  const s = threeSentenceSession();
  assert.deepEqual([...mergeSelectable(s, ['s2', 'gone'])].sort(), ['s1', 's2', 's3']);
});

test('mergeSelectable: an empty session offers nothing rather than throwing', () => {
  assert.deepEqual([...mergeSelectable({ sentences: [] }, ['s1'])], []);
  assert.deepEqual([...mergeSelectable(null, [])], []);
});

function threeSentenceSession() {
  return { sentences: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] };
}

test('setOnEverySentence: sets the field on the ones that differ, and stamps only those', () => {
  const before = {
    sentences: [
      { id: 's1', hidden: false, updatedAt: 1 },
      { id: 's2', hidden: true, updatedAt: 1 },
    ],
    updatedAt: 1,
  };

  const after = setOnEverySentence(before, { hidden: true }, 50);

  assert.deepEqual(after.sentences.map((s) => [s.hidden, s.updatedAt]), [[true, 50], [true, 1]]);
  assert.equal(after.updatedAt, 50);
});

test('setOnEverySentence: nothing to change gives back the same session, so nothing repaints or syncs', () => {
  const before = { sentences: [{ id: 's1', hidden: true, updatedAt: 1 }], updatedAt: 1 };
  assert.equal(setOnEverySentence(before, { hidden: true }, 50), before);
});

test('setOnEverySentence: an empty session is left alone rather than restamped', () => {
  const before = { sentences: [], updatedAt: 1 };
  assert.equal(setOnEverySentence(before, { hidden: true }, 50), before);
});

test('isWorthStoring: a session earns its place by holding something', () => {
  const blank = { id: 'a', sentences: [], sourceAudio: null };

  assert.equal(isWorthStoring(blank), false);
  assert.equal(isWorthStoring({ ...blank, sentences: [{ id: 's1' }] }), true);
  assert.equal(isWorthStoring({ ...blank, sourceAudio: 'FILE' }), true, 'an import in progress counts');
});

test('isWorthStoring: typed text on its own is not yet a session', () => {
  // What is in the box has not been split into anything; there is nothing to
  // list in the library and nothing to open.
  assert.equal(isWorthStoring({ id: 'a', sentences: [], sourceAudio: null, inputText: 'typed but not split' }), false);
});

test('isWorthStoring: nothing on screen is not something to store', () => {
  assert.equal(isWorthStoring(null), false);
  assert.equal(isWorthStoring(undefined), false);
});
