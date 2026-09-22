import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWordTimeline, padBounds, resegment, PAD_MS , wordAt, alignWordsToText} from '../../js/model/transcript.js';

/** A phrase as the cloud boundary normalises it. */
const phrase = (lang, words, over = {}) => ({
  lang,
  text: words.map((w) => w.text).join(lang === 'ja' ? '' : ' '),
  words,
  ...over,
});
const word = (text, offsetMs, durationMs) => ({ text, offsetMs, durationMs });

test('buildWordTimeline: English words are spaced and their char ranges recorded', () => {
  const { text, words } = buildWordTimeline([phrase('en', [word('one', 0, 100), word('two', 200, 100)])]);
  assert.equal(text, 'one two');
  assert.deepEqual(words.map((w) => [w.start, w.end]), [[0, 3], [4, 7]]);
});

test('buildWordTimeline: Japanese words run together, with no inserted spaces', () => {
  const { text, words } = buildWordTimeline([phrase('ja', [word('今日', 0, 100), word('は', 100, 50)])]);
  assert.equal(text, '今日は');
  assert.deepEqual(words.map((w) => [w.start, w.end]), [[0, 2], [2, 3]]);
});

test('buildWordTimeline: a phrase break becomes a space even between Japanese phrases', () => {
  const { text } = buildWordTimeline([
    phrase('ja', [word('そうです', 0, 200)]),
    phrase('ja', [word('はい', 500, 100)]),
  ]);
  assert.equal(text, 'そうです はい');
});

test('buildWordTimeline: the phrase-break space is what keeps a sentence boundary visible', () => {
  // A period only terminates when whitespace follows. Without the inserted
  // space, "weeks." glued onto "Then" would hide the boundary entirely and the
  // two sentences would merge into one.
  const { text } = buildWordTimeline([
    phrase('en', [word('Two', 0, 100), word('weeks.', 200, 200)]),
    phrase('en', [word('Then', 800, 100)]),
  ]);
  assert.equal(text, 'Two weeks. Then');
  assert.deepEqual(resegment([
    phrase('en', [word('Two', 0, 100), word('weeks.', 200, 200)]),
    phrase('en', [word('Then', 800, 100)]),
  ]).map((s) => s.text), ['Two weeks.', 'Then']);
});

test('buildWordTimeline: words with no text are skipped', () => {
  const { text, words } = buildWordTimeline([phrase('en', [word('one', 0, 10), word('', 20, 10), word('two', 30, 10)])]);
  assert.equal(text, 'one two');
  assert.equal(words.length, 2);
});

test('buildWordTimeline: no phrases gives empty output rather than throwing', () => {
  assert.deepEqual(buildWordTimeline([]), { text: '', words: [] });
  assert.deepEqual(buildWordTimeline(null), { text: '', words: [] });
});

test('padBounds: with no neighbours the full margin is applied on both sides', () => {
  assert.deepEqual(padBounds({ startMs: 1000, endMs: 2000 }), {
    offsetMs: 1000 - PAD_MS,
    durationMs: 1000 + PAD_MS * 2,
  });
});

test('padBounds: the margin is capped at half the silence to each neighbour', () => {
  // 100ms of silence on the left: at most 50ms may be used, so two sentences
  // padding toward each other meet at the midpoint and never overlap.
  const result = padBounds({ startMs: 1000, endMs: 2000, prevEndMs: 900, nextStartMs: 2060 });
  assert.equal(result.offsetMs, 950);
  assert.equal(result.offsetMs + result.durationMs, 2030);
});

test('padBounds: two adjacent sentences pad toward each other without overlapping', () => {
  const gapStart = 1000;
  const gapEnd = 1100;
  const left = padBounds({ startMs: 0, endMs: gapStart, nextStartMs: gapEnd });
  const right = padBounds({ startMs: gapEnd, endMs: 2000, prevEndMs: gapStart });
  assert.ok(left.offsetMs + left.durationMs <= right.offsetMs, 'the clips do not overlap');
  assert.equal(left.offsetMs + left.durationMs, right.offsetMs, 'and they meet exactly at the midpoint');
});

test('padBounds: never starts before the file, and never runs past its end', () => {
  assert.equal(padBounds({ startMs: 10, endMs: 500 }).offsetMs, 0);
  const capped = padBounds({ startMs: 100, endMs: 1000, totalDurationMs: 1050 });
  assert.equal(capped.offsetMs + capped.durationMs, 1050);
});

test('padBounds: touching neighbours means no margin at all, not a negative one', () => {
  const result = padBounds({ startMs: 1000, endMs: 2000, prevEndMs: 1000, nextStartMs: 2000 });
  assert.deepEqual(result, { offsetMs: 1000, durationMs: 1000 });
});

test('resegment: splits by punctuation rather than by the service\'s phrase boundaries', () => {
  // One phrase containing two sentences -- exactly the case pause-based
  // segmentation gets wrong.
  const segments = resegment([
    phrase('en', [word('Hello', 0, 200), word('there.', 300, 300), word('How', 900, 200), word('are', 1200, 100), word('you?', 1400, 300)]),
  ]);
  assert.deepEqual(segments.map((s) => s.text), ['Hello there.', 'How are you?']);
});

test('resegment: each sentence\'s range comes from the words it contains', () => {
  const [first, second] = resegment([
    phrase('en', [word('One.', 1000, 200), word('Two.', 5000, 200)]),
  ], 10_000);

  assert.ok(first.offsetMs < 1000 && first.offsetMs >= 1000 - PAD_MS);
  assert.ok(first.offsetMs + first.durationMs <= 5000, 'the first clip stops short of the second sentence');
  assert.ok(second.offsetMs >= 1200, 'and the second starts after the first');
});

test('resegment: per-word positions are re-based onto the sentence\'s own text', () => {
  const [, second] = resegment([
    phrase('en', [word('One.', 0, 200), word('Two', 1000, 200), word('three.', 1300, 300)]),
  ]);
  assert.equal(second.text, 'Two three.');
  assert.deepEqual(second.words.map((w) => [w.charStart, w.charEnd]), [[0, 3], [4, 10]]);
  assert.deepEqual(second.words.map((w) => w.offsetMs), [1000, 1300]);
});

test('resegment: word positions never fall outside the sentence they belong to', () => {
  const segments = resegment([phrase('ja', [word('今日は。', 0, 500), word('はい。', 1000, 300)])]);
  for (const segment of segments) {
    for (const w of segment.words) {
      assert.ok(w.charStart >= 0 && w.charEnd <= segment.text.length, `${w.charStart}..${w.charEnd} within "${segment.text}"`);
    }
  }
});

test('resegment: a sentence of mostly Japanese words is labelled ja, otherwise en', () => {
  const ja = resegment([phrase('ja', [word('今日は', 0, 300), word('いい', 400, 200), word('天気。', 700, 300)])]);
  assert.deepEqual(ja.map((s) => s.lang), ['ja']);

  const en = resegment([phrase('en', [word('Nice', 0, 200), word('weather.', 300, 300)])]);
  assert.deepEqual(en.map((s) => s.lang), ['en']);
});

test('resegment: a repeated sentence maps to its own occurrence, not the first one', () => {
  const segments = resegment([
    phrase('en', [word('Yes.', 0, 200), word('No.', 1000, 200), word('Yes.', 2000, 200)]),
  ]);
  assert.deepEqual(segments.map((s) => s.text), ['Yes.', 'No.', 'Yes.']);
  // Each sentence takes the range of the word at its own position. The two
  // identical "Yes." sentences must therefore differ -- if the second had
  // re-matched the first's position, both would carry the same range and the
  // third clip would play the first word's audio.
  assert.deepEqual(segments.map((s) => Math.round(s.offsetMs)), [0, 880, 1880]);
  assert.notEqual(segments[0].offsetMs, segments[2].offsetMs);
});

test('resegment: no usable word timing yields nothing, for the caller to fall back', () => {
  assert.deepEqual(resegment([{ lang: 'en', text: 'No words here.', words: [] }]), []);
  assert.deepEqual(resegment([]), []);
  assert.deepEqual(resegment([{ lang: 'en', text: '   ', words: [] }]), []);
});

test('resegment: multiple phrases are stitched into one timeline before splitting', () => {
  const segments = resegment([
    phrase('en', [word('First', 0, 200), word('one', 300, 200)]),
    phrase('en', [word('and', 700, 100), word('second.', 900, 400)]),
  ]);
  assert.deepEqual(segments.map((s) => s.text), ['First one and second.']);
  assert.equal(segments[0].words.length, 4);
});

test('wordAt: finds the word being spoken, and nothing between words', () => {
  const words = [
    { charStart: 0, charEnd: 3, offsetMs: 100, durationMs: 200 },
    { charStart: 4, charEnd: 9, offsetMs: 500, durationMs: 300 },
  ];

  assert.equal(wordAt(words, 100).charStart, 0, 'the first instant of a word counts');
  assert.equal(wordAt(words, 299).charStart, 0);
  assert.equal(wordAt(words, 300), null, 'its last instant belongs to the gap, not to it');
  assert.equal(wordAt(words, 400), null, 'a pause lights nothing');
  assert.equal(wordAt(words, 700).charStart, 4);
  assert.equal(wordAt(words, 900), null, 'past the end');
  assert.equal(wordAt(words, 0), null, 'before the first');
});

test('wordAt: a word at 0ms is found -- 0 is a real timestamp', () => {
  assert.equal(wordAt([{ charStart: 0, charEnd: 2, offsetMs: 0, durationMs: 50 }], 0).charEnd, 2);
});

test('wordAt: nothing to follow gives null rather than throwing', () => {
  assert.equal(wordAt(null, 10), null);
  assert.equal(wordAt([], 10), null);
  assert.equal(wordAt([{ charStart: 0, charEnd: 1, offsetMs: null, durationMs: null }], 10), null);
  assert.equal(wordAt([{ charStart: 0, charEnd: 1, offsetMs: 0, durationMs: 10 }], null), null);
});

// ---- Putting a transcript's timings back onto the text that was read ----

const spokenAs = (...words) => [{ words: words.map(([text, offsetMs, durationMs]) => ({ text, offsetMs, durationMs })) }];

test('alignWordsToText: locates each spoken word in the text, ignoring punctuation', () => {
  const words = alignWordsToText(spokenAs(['One,', 0, 300], ['sentence.', 400, 500]), 'One sentence.');
  assert.deepEqual(words, [
    { charStart: 0, charEnd: 3, offsetMs: 0, durationMs: 300 },
    { charStart: 4, charEnd: 12, offsetMs: 400, durationMs: 500 },
  ]);
});

test('alignWordsToText: works the same for Japanese, which has no spaces to help', () => {
  const words = alignWordsToText(spokenAs(['今日', 0, 300], ['は', 300, 100], ['いい', 400, 200]), '今日はいい天気ですね。');
  assert.deepEqual(words.map((w) => [w.charStart, w.charEnd]), [[0, 2], [2, 3], [3, 5]]);
});

test('alignWordsToText: never backtracks, so a repeated word matches the next one along', () => {
  const words = alignWordsToText(spokenAs(['very', 0, 100], ['very', 200, 100], ['good', 400, 100]), 'very very good');
  assert.deepEqual(words.map((w) => w.charStart), [0, 5, 10]);
});

test('alignWordsToText: a word that cannot be found is skipped, not fatal to the rest', () => {
  const words = alignWordsToText(spokenAs(['One', 0, 100], ['misheard', 150, 100], ['sentence', 300, 100]), 'One sentence.');
  assert.deepEqual(words.map((w) => w.charStart), [0, 4]);
});

test('alignWordsToText: a number the reading reformatted still finds its place', () => {
  // "18,000" read aloud comes back as one "18000" token, which is not a
  // substring of the original at all.
  const words = alignWordsToText(spokenAs(['18000', 0, 400]), 'It costs 18,000 yen.');
  assert.deepEqual(words, [{ charStart: 9, charEnd: 15, offsetMs: 0, durationMs: 400 }]);
});

test('alignWordsToText: nothing matched at all is null, not an empty list', () => {
  assert.equal(alignWordsToText(spokenAs(['zzz', 0, 10]), 'Nothing here.'), null);
  assert.equal(alignWordsToText([], 'Nothing here.'), null);
  assert.equal(alignWordsToText(null, 'Nothing here.'), null);
  assert.equal(alignWordsToText(spokenAs(['x', 0, 1]), ''), null);
});

test('alignWordsToText: a token that is pure punctuation is not a word to locate', () => {
  const words = alignWordsToText(spokenAs(['--', 0, 10], ['Hello', 20, 100]), 'Hello there.');
  assert.deepEqual(words.map((w) => w.charStart), [0]);
});

test('alignWordsToText: a token that ran several words together still finds them', () => {
  // Reported: "Hello A B C D E", spoken, offered only "Hello" to pick from.
  // The reading came back with the letters as one token, which is not a
  // substring of the text at all -- so everything after "Hello" was dropped
  // and the sentence looked like a one-word sentence.
  const words = alignWordsToText(spokenAs(['Hello', 0, 300], ['ABCDE', 400, 900]), 'Hello A B C D E');

  assert.equal(words.length, 2);
  assert.deepEqual(words.map((w) => 'Hello A B C D E'.slice(w.charStart, w.charEnd)), ['Hello', 'A B C D E']);
  assert.deepEqual(words.map((w) => [w.offsetMs, w.durationMs]), [[0, 300], [400, 900]]);
});

test('alignWordsToText: the letters spoken one at a time land on themselves', () => {
  const text = 'Hello A B C D E';
  const words = alignWordsToText(
    spokenAs(['Hello', 0, 300], ['A.', 400, 100], ['B.', 500, 100], ['C.', 600, 100], ['D.', 700, 100], ['E.', 800, 100]),
    text,
  );

  assert.deepEqual(words.map((w) => text.slice(w.charStart, w.charEnd)), ['Hello', 'A', 'B', 'C', 'D', 'E']);
});

test('alignWordsToText: an apostrophe the reading dropped does not lose the word', () => {
  const text = "I don't know";
  const words = alignWordsToText(spokenAs(['I', 0, 100], ['dont', 100, 200], ['know', 300, 200]), text);

  assert.deepEqual(words.map((w) => text.slice(w.charStart, w.charEnd)), ['I', "don't", 'know']);
});

test('alignWordsToText: a span never starts or ends on punctuation', () => {
  // The span is the letters that matched, so a picked word does not arrive in
  // the vocabulary library wearing the comma that followed it.
  const text = 'Well, yes.';
  const words = alignWordsToText(spokenAs(['Well,', 0, 200], ['yes.', 300, 200]), text);

  assert.deepEqual(words.map((w) => text.slice(w.charStart, w.charEnd)), ['Well', 'yes']);
});

test('alignWordsToText: positions are counted in characters, not in UTF-16 units', () => {
  // A character outside the basic plane is one character everywhere else in the
  // app (geometry.js counts code points), so a span that counted its halves
  // separately would put every later cut marker a position out and cut audio
  // from the wrong moment.
  const words = alignWordsToText(spokenAs(['\u{20B9F}\u308B', 0, 500], ['\u3053\u3068', 500, 300]), '\u{20B9F}\u308B\u3053\u3068');

  assert.deepEqual(words, [
    { charStart: 0, charEnd: 2, offsetMs: 0, durationMs: 500 },
    { charStart: 2, charEnd: 4, offsetMs: 500, durationMs: 300 },
  ]);
});

test('alignWordsToText: a character that lowercases to two is still one position', () => {
  // \u0130 lowercases to two code points. Counting them as two positions in the
  // text desynchronised the projection from its way back, and the span that
  // followed came out with no end at all.
  const words = alignWordsToText(spokenAs(['okay', 10, 20]), '\u0130stanbul okay');

  assert.deepEqual(words, [{ charStart: 9, charEnd: 13, offsetMs: 10, durationMs: 20 }]);
});
