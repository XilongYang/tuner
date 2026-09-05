// Regression test for: "你需要把标点符号也好好处理了，并且不要使用这么严苛的
// 精确匹配，改为逐词双指针" -- matchWordsToText() (tts-player.js) no longer
// requires the WHOLE reconstructed transcript to equal the original text
// (which failed on any punctuation Azure's ITN added/dropped, e.g. a
// missing trailing comma, or restructured, e.g. "18,000" -> "18" + "000").
// It now walks Azure's words one at a time and, for each, searches `text`
// for that word's punctuation-stripped core starting just past where the
// previous word was found (never backtracking) -- so punctuation is never
// compared at all, and one word Azure misheard only costs that ONE word its
// timestamp, not the whole sentence's.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');
await page.waitForLoadState('networkidle');

const result = await page.evaluate(async () => {
  const { matchWordsToText } = await import('/js/tts-player.js');

  function phraseOf(wordTexts, startMs = 0) {
    const words = [];
    let t = startMs;
    for (const text of wordTexts) {
      words.push({ text, offsetMilliseconds: t, durationMilliseconds: 200 });
      t += 250;
    }
    return { words };
  }
  const slice = (text, w) => text.slice(w.charStart, w.charEnd);

  // --- 1. The real-world case that started this: Azure dropped the
  // sentence's own trailing comma (present in the original, absent from the
  // ASR reconstruction) -- under the old whole-string rule this failed EVERY
  // word in the sentence. Now only the punctuation itself is irrelevant (it's
  // never compared), so every real word still gets located and timestamped. ---
  const text1 = 'These AIs colluded to share answers, research their environment,';
  const phrases1 = [phraseOf(['These', 'AIS', 'colluded', 'to', 'share', 'answers', 'research', 'their', 'environment'])];
  const words1 = matchWordsToText(phrases1, text1, 'en');
  const covered1 = words1 && words1.map((w) => slice(text1, w));

  // --- 2. Azure restructuring a number into separate tokens ("18,000" ->
  // "18" + "000") -- previously a hard, whole-sentence failure. Each token is
  // still an independent substring search, so both are still found (in order,
  // the comma between them just never gets compared) and every OTHER word in
  // the sentence keeps its own exact timestamp too. ---
  const text2 = 'We found ~18,000 posts from autonomous agents.';
  const phrases2 = [phraseOf(['We', 'found', '18', '000', 'posts', 'from', 'autonomous', 'agents'])];
  const words2 = matchWordsToText(phrases2, text2, 'en');
  const covered2 = words2 && words2.map((w) => slice(text2, w));

  // --- 2b. The actual real-world case: Azure merged "18,000" into ONE token
  // "18000" with the comma gone entirely (not split into "18"+"000" like
  // test 2 above) -- a plain substring search for "18000" can't find it
  // inside "18,000" at all, since the comma breaks contiguity. findCore()'s
  // digit-grouping-aware fallback should still locate the whole "18,000"
  // span (comma included) as this one word's timestamp. ---
  const text2b = 'We found ~18,000 posts from autonomous agents.';
  const phrases2b = [phraseOf(['We', 'found', '18000', 'posts', 'from', 'autonomous', 'agents'])];
  const words2b = matchWordsToText(phrases2b, text2b, 'en');
  const covered2b = words2b && words2b.map((w) => slice(text2b, w));

  // --- 3. Partial credit: one word genuinely misheard ("world" -> "universe")
  // must not cost the OTHER words in the sentence their timestamps -- only
  // the misheard word itself gets skipped (no entry at all, not a wrong one). ---
  const text3 = 'Hello world, my friend.';
  const phrases3 = [phraseOf(['Hello', 'universe', 'my', 'friend'])];
  const words3 = matchWordsToText(phrases3, text3, 'en');
  const covered3 = words3 && words3.map((w) => slice(text3, w));

  // --- 4. Plain exact match (no punctuation weirdness, no mishearing) still
  // works and still covers every word -- sanity check against a regression
  // in the common case. ---
  const text4 = 'Hello world.';
  const phrases4 = [phraseOf(['Hello', 'world.'])];
  const words4 = matchWordsToText(phrases4, text4, 'en');
  const covered4 = words4 && words4.map((w) => slice(text4, w));

  // --- 5. Nothing locatable at all (e.g. silence/garbage transcription) ->
  // null, not an empty-but-truthy array a caller might mistake for success. ---
  const text5 = 'Hello world.';
  const phrases5 = [phraseOf(['completely', 'unrelated', 'gibberish'])];
  const words5 = matchWordsToText(phrases5, text5, 'en');

  return { covered1, covered2, covered2b, covered3, covered4, words5 };
});

console.log(JSON.stringify(result, null, 2));

await browser.close();
console.log('LOGS:', logs);
