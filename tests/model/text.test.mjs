import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentText, vocabKey, detectLang, canCutBetween, seamSeparator, sliceChars } from '../../js/model/text.js';

test('segmentText: splits on Japanese terminal punctuation, keeping it', () => {
  assert.deepEqual(segmentText('おはよう。元気ですか？はい！'), ['おはよう。', '元気ですか？', 'はい！']);
});

test('segmentText: splits on English terminal punctuation, keeping it', () => {
  assert.deepEqual(segmentText('One. Two! Three?'), ['One.', 'Two!', 'Three?']);
});

test('segmentText: a period inside a token does not split it', () => {
  assert.deepEqual(segmentText('It costs 3.5 dollars.'), ['It costs 3.5 dollars.']);
  assert.deepEqual(segmentText('Born in the U.S.A today'), ['Born in the U.S.A today']);
});

test('segmentText: an abbreviation ending a word DOES split -- documented, not fixed', () => {
  // Asserting the real behaviour rather than an ideal. Recognising these needs
  // an abbreviation list; see the note in model/text.js for why that trade is
  // not taken. A wrong split is recoverable by merging the two pieces.
  assert.deepEqual(segmentText('Mr. Smith arrived.'), ['Mr.', 'Smith arrived.']);
  assert.deepEqual(segmentText('Popular in the U.S. today.'), ['Popular in the U.S.', 'today.']);
});

test('segmentText: a newline separates even without punctuation', () => {
  assert.deepEqual(segmentText('Chapter one\nNo punctuation here\nThird line'),
    ['Chapter one', 'No punctuation here', 'Third line']);
});

test('segmentText: blank lines and surrounding whitespace are dropped', () => {
  assert.deepEqual(segmentText('  first.  \n\n\n   \n  second.  '), ['first.', 'second.']);
});

test('segmentText: runs of punctuation stay with their sentence', () => {
  assert.deepEqual(segmentText('What?! Really…'), ['What?!', 'Really…']);
});

test('segmentText: a trailing fragment with no punctuation is still a sentence', () => {
  assert.deepEqual(segmentText('Done. And then'), ['Done.', 'And then']);
});

test('segmentText: empty input gives an empty list, not [""]', () => {
  assert.deepEqual(segmentText(''), []);
  assert.deepEqual(segmentText(null), []);
  assert.deepEqual(segmentText('   \n  '), []);
});

test('segmentText: repeated calls give identical results -- no regex state carried between them', () => {
  // A module-level global regex would carry lastIndex across calls and make
  // the second one wrong. Interleaving two inputs catches that.
  const a = segmentText('One. Two. Three.');
  const b = segmentText('Alpha. Beta.');
  assert.deepEqual(segmentText('One. Two. Three.'), a);
  assert.deepEqual(segmentText('Alpha. Beta.'), b);
  assert.deepEqual(a, ['One.', 'Two.', 'Three.']);
  assert.deepEqual(b, ['Alpha.', 'Beta.']);
});

test('vocabKey: strips punctuation and case so one word is one entry', () => {
  assert.equal(vocabKey('Hello, world!'), 'helloworld');
  assert.equal(vocabKey('hello world'), 'helloworld');
  assert.equal(vocabKey('HELLO'), 'hello');
});

test('vocabKey: a trailing comma does not create a second entry', () => {
  assert.equal(vocabKey('difficult,'), vocabKey('difficult'));
});

test('vocabKey: keeps Japanese text intact while dropping its punctuation', () => {
  assert.equal(vocabKey('難しい。'), '難しい');
  assert.equal(vocabKey('「勉強」'), '勉強');
});

test('vocabKey: input that reduces to nothing returns empty, for the caller to refuse', () => {
  assert.equal(vocabKey('...'), '');
  assert.equal(vocabKey('　 '), '');
  assert.equal(vocabKey(''), '');
  assert.equal(vocabKey(null), '');
});

test('detectLang: any kana or CJK character means Japanese', () => {
  assert.equal(detectLang('今日はいい天気ですね。'), 'ja');
  assert.equal(detectLang('はい'), 'ja');
  assert.equal(detectLang('カタカナ'), 'ja');
  assert.equal(detectLang('漢字'), 'ja');
});

test('detectLang: halfwidth katakana is kana too', () => {
  // It comes out of older systems and out of some Japanese keyboards, and a
  // sentence of it read back in an English voice is the first thing anyone
  // notices.
  assert.equal(detectLang('ﾊﾝｶｸ'), 'ja');
  assert.equal(detectLang('hello'), 'en', 'and Latin text is still English');
});

test('detectLang: text with none of those is English', () => {
  assert.equal(detectLang('The weather is lovely today.'), 'en');
  assert.equal(detectLang('3.5 dollars'), 'en');
  assert.equal(detectLang(''), 'en');
  assert.equal(detectLang(null), 'en');
});

test('detectLang: a mixed sentence counts as Japanese, which is the voice it needs', () => {
  assert.equal(detectLang('この PDF を読んでください。'), 'ja');
});

test('detectLang: an astral CJK character is recognised', () => {
  assert.equal(detectLang('𠮟る'), 'ja');
});

test('canCutBetween: between two kana, yes -- that is where a cut falls in Japanese', () => {
  assert.equal(canCutBetween('今', '日'), true);
  assert.equal(canCutBetween('す', '。'), true);
});

test('canCutBetween: inside an English word, no', () => {
  assert.equal(canCutBetween('e', 'n'), false);
  assert.equal(canCutBetween('3', '5'), false);
  assert.equal(canCutBetween('U', '.'), false, 'nor between a word and its punctuation');
  assert.equal(canCutBetween('.', 'S'), false);
});

test('canCutBetween: at the start of a word, yes', () => {
  assert.equal(canCutBetween(' ', 'b'), true);
  assert.equal(canCutBetween('\n', 'b'), true);
});

test('canCutBetween: never immediately before whitespace, which would begin the next half with a space', () => {
  assert.equal(canCutBetween('a', ' '), false);
  assert.equal(canCutBetween('。', ' '), false);
  assert.equal(canCutBetween(' ', ' '), false);
});

test('seamSeparator: English sentences rejoin with the space segmentation trimmed', () => {
  assert.equal(seamSeparator('One sentence.', 'Two sentences.'), ' ');
  assert.equal(seamSeparator('終わり。', 'Next one.'), ' ', 'one Latin side is enough');
});

test('seamSeparator: Japanese rejoins with nothing', () => {
  assert.equal(seamSeparator('今日はいい天気ですね。', '散歩に行きましょう。'), '');
  assert.equal(seamSeparator('はい', 'いいえ'), '');
});

test('seamSeparator: a seam that already has its whitespace gets nothing, so a split rejoins exactly', () => {
  assert.equal(seamSeparator('Alpha ', 'beta'), '');
  assert.equal(seamSeparator('Alpha', ' beta'), '');
});

test('seamSeparator: nothing to join, nothing to insert', () => {
  assert.equal(seamSeparator('', 'beta'), '');
  assert.equal(seamSeparator('Alpha', ''), '');
  assert.equal(seamSeparator(null, null), '');
});

test('sliceChars: cuts by character, so a span after an astral character is the span that was meant', () => {
  const text = '𠮷野家で 食べた';
  assert.equal(sliceChars(text, 5, 8), '食べた');
  assert.equal(sliceChars(text, 0, 4), '𠮷野家で');
  // The same call on the string itself is the bug this exists to prevent.
  assert.equal(text.slice(5, 8), ' 食べ');
});
