// End-to-end smoke test for the "Add vocab" feature: the row button only
// shows once sentence.words exists, opening it renders one clickable span
// per word unit, selecting words and clicking Confirm writes vocab entries to
// IndexedDB (store/vocab.js) -- one per contiguous run of selected words,
// non-adjacent selections becoming separate entries. No real Azure calls
// here (no credentials configured), so each entry's audio resolves to null
// (text-only) -- this only exercises the picker UI + store write path, not
// audio slicing/synthesis (covered by the vocab-audio.js/store-vocab unit
// tests instead).
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');
await page.waitForLoadState('networkidle');

// --- 1. No word data yet: the button stays hidden. ---
const beforeWordsResult = await page.evaluate(async () => {
  const { setSentences } = await import('/js/state.js');
  const { render } = await import('/js/sentence-panel/split-render.js');
  const { Recorder } = await import('/js/recorder.js');

  const sentence = {
    id: crypto.randomUUID(), text: 'one two three', lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: null,
    sourceOffsetMs: null, sourceDurationMs: null, words: null, manualPoints: null,
  };
  setSentences([sentence]);
  render();
  const btn = Array.from(document.querySelectorAll('.row-actions .btn')).find((b) => b.textContent === 'Add vocab');
  return { hidden: btn ? btn.hidden : 'not-found' };
});
console.log('vocab button before word data:', JSON.stringify(beforeWordsResult));

// --- 2. Real word spans present -> button visible; open the picker, select
// two adjacent words (indices 0,1 -- "one"+"two") and one non-adjacent word
// (index 2 -- "three"), confirm, and check the vocab store got two entries. ---
const pickerResult = await page.evaluate(async () => {
  const { setSentences, currentSessionId } = await import('/js/state.js');
  const { render } = await import('/js/sentence-panel/split-render.js');
  const { Recorder } = await import('/js/recorder.js');
  const store = await import('/js/store/index.js');

  const sentence = {
    id: crypto.randomUUID(), text: 'one two three', lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: null,
    sourceOffsetMs: null, sourceDurationMs: null, manualPoints: null,
    words: [
      { charStart: 0, charEnd: 3, offsetMilliseconds: 0, durationMilliseconds: 300, word: 'one' },
      { charStart: 4, charEnd: 7, offsetMilliseconds: 300, durationMilliseconds: 300, word: 'two' },
      { charStart: 8, charEnd: 13, offsetMilliseconds: 600, durationMilliseconds: 300, word: 'three' },
    ],
  };
  setSentences([sentence]);
  render();

  const btn = Array.from(document.querySelectorAll('.row-actions .btn')).find((b) => b.textContent === 'Add vocab');
  const btnHiddenWithWords = btn.hidden;
  btn.click();
  await new Promise((r) => setTimeout(r, 50));

  const wordSpans = Array.from(document.querySelectorAll('.vocab-picker-word'));
  const wordTexts = wordSpans.map((s) => s.textContent);
  wordSpans[0].click(); // "one"
  wordSpans[1].click(); // "two" -- adjacent to "one", same group
  wordSpans[2].click(); // "three" -- selected too, but grouping is by index-adjacency so 0,1,2 are all adjacent

  const confirmBtn = document.querySelector('.modal-actions .btn.primary');
  confirmBtn.click();
  await new Promise((r) => setTimeout(r, 100));

  const modalGone = !document.querySelector('.modal-backdrop');
  const vocab = await store.listVocab();

  return {
    btnHiddenWithWords, wordTexts, modalGone,
    vocabCount: vocab.length,
    vocabIds: vocab.map((v) => v.id),
    vocabSources0: vocab[0] ? vocab[0].sources.map((s) => ({ hasAudio: s.hasAudio, sessionId: s.sessionId, sentenceId: s.sentenceId })) : null,
  };
});
console.log('picker result (all-selected, all-adjacent):', JSON.stringify(pickerResult));

// --- 3. Non-adjacent selection (indices 0 and 2, skipping 1) produces TWO
// separate vocab entries instead of one. ---
const nonAdjacentResult = await page.evaluate(async () => {
  const { setSentences } = await import('/js/state.js');
  const { render } = await import('/js/sentence-panel/split-render.js');
  const { Recorder } = await import('/js/recorder.js');
  const store = await import('/js/store/index.js');

  const sentence = {
    id: crypto.randomUUID(), text: 'alpha beta gamma', lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: null,
    sourceOffsetMs: null, sourceDurationMs: null, manualPoints: null,
    words: [
      { charStart: 0, charEnd: 5, offsetMilliseconds: 0, durationMilliseconds: 300, word: 'alpha' },
      { charStart: 6, charEnd: 10, offsetMilliseconds: 300, durationMilliseconds: 300, word: 'beta' },
      { charStart: 11, charEnd: 16, offsetMilliseconds: 600, durationMilliseconds: 300, word: 'gamma' },
    ],
  };
  setSentences([sentence]);
  render();

  const btn = Array.from(document.querySelectorAll('.row-actions .btn')).find((b) => b.textContent === 'Add vocab');
  btn.click();
  await new Promise((r) => setTimeout(r, 50));

  const wordSpans = Array.from(document.querySelectorAll('.vocab-picker-word'));
  wordSpans[0].click(); // "alpha"
  wordSpans[2].click(); // "gamma" -- non-adjacent to "alpha"

  const confirmBtn = document.querySelector('.modal-actions .btn.primary');
  confirmBtn.click();
  await new Promise((r) => setTimeout(r, 100));

  const vocab = await store.listVocab();
  return { vocabCount: vocab.length, vocabIds: vocab.map((v) => v.id).sort() };
});
console.log('picker result (non-adjacent selection):', JSON.stringify(nonAdjacentResult));

// --- 4. Cancel leaves the store untouched. ---
const cancelResult = await page.evaluate(async () => {
  const { setSentences } = await import('/js/state.js');
  const { render } = await import('/js/sentence-panel/split-render.js');
  const { Recorder } = await import('/js/recorder.js');
  const store = await import('/js/store/index.js');

  const before = (await store.listVocab()).length;

  const sentence = {
    id: crypto.randomUUID(), text: 'cancel me', lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: null,
    sourceOffsetMs: null, sourceDurationMs: null, manualPoints: null,
    words: [
      { charStart: 0, charEnd: 6, offsetMilliseconds: 0, durationMilliseconds: 300, word: 'cancel' },
      { charStart: 7, charEnd: 9, offsetMilliseconds: 300, durationMilliseconds: 300, word: 'me' },
    ],
  };
  setSentences([sentence]);
  render();

  const btn = Array.from(document.querySelectorAll('.row-actions .btn')).find((b) => b.textContent === 'Add vocab');
  btn.click();
  await new Promise((r) => setTimeout(r, 50));
  document.querySelectorAll('.vocab-picker-word')[0].click();
  document.querySelector('.modal-actions .btn:not(.primary)').click(); // Cancel
  await new Promise((r) => setTimeout(r, 50));

  const after = (await store.listVocab()).length;
  return { before, after, modalGone: !document.querySelector('.modal-backdrop') };
});
console.log('cancel result:', JSON.stringify(cancelResult));

await browser.close();
console.log('LOGS:', logs);
