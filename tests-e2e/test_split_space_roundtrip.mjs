// Regression test for: "现在分割英语再恢复时会丢掉空格，把分割逻辑改成空格留在
// 上一个句子末尾" -- splitting an English sentence at a real Azure word
// boundary used to trim() both halves, which threw away the space between
// words; since mergeSelectedSentences() joins sentence texts back together
// with NO separator (a deliberate earlier change, so Japanese doesn't gain
// spurious spaces), a Split immediately followed by a Merge silently lost
// the space for good. Fixed by keeping the whitespace at the split boundary
// attached to the LEFT half instead of trimming it away on either side.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');
await page.waitForLoadState('networkidle');

const result = await page.evaluate(async () => {
  const stateMod = await import('/js/state.js');
  const splitRenderMod = await import('/js/sentence-panel/split-render.js');
  const splitGeometryMod = await import('/js/sentence-panel/split-geometry.js');
  const splitActionsMod = await import('/js/sentence-panel/split-actions.js');
  const splitMod = { ...splitRenderMod, ...splitGeometryMod, ...splitActionsMod };
  const recorderMod = await import('/js/recorder.js');
  const { Recorder, encodeWav } = recorderMod;
  const { setSentences, setSourceAudio } = stateMod;
  const { getSplitPointers, splitAtPointer, render } = splitMod;

  const sampleRate = 16000;
  const totalMs = 2000;
  const totalSamples = Math.round((totalMs / 1000) * sampleRate);
  const samples = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) samples[i] = 0.5 * Math.sin(i * 0.3);
  const sourceBlob = new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' });
  setSourceAudio(sourceBlob, 'test-hash');

  // --- 1. Split at a real Azure word pointer: the space must stay on the
  // LEFT half's own text, not vanish. ---
  const text = 'Alpha beta';
  const words = [
    { offsetMilliseconds: 0, durationMilliseconds: 900, charStart: 0, charEnd: 5 },
    { offsetMilliseconds: 900, durationMilliseconds: 1100, charStart: 6, charEnd: 10 },
  ];
  const sentence = {
    id: crypto.randomUUID(), text, lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: 'import',
    sourceOffsetMs: 0, sourceDurationMs: totalMs, words, manualPoints: null,
  };
  setSentences([sentence]);
  render();

  const exact = (getSplitPointers(sentence).find((p) => p.charIndex === 6) || null);
  await splitAtPointer(sentence, exact.charIndex, exact.ms);
  const [left, right] = stateMod.sentences;
  const wordSplitResult = {
    leftText: left.text,
    rightText: right.text,
    // The actual bug: rejoin with NO separator (mergeSelectedSentences()'s
    // own join('')) and the original text must come back byte-for-byte.
    roundTripsExactly: left.text + right.text === text,
  };

  // --- 2. The actual end-to-end scenario reported: Merge those same two
  // pieces ("Alpha " + "beta") straight back together, right after the
  // Split above, while they're still the ones on screen.
  // mergeSelectedSentences() joins with NO separator of its own (by design,
  // so Japanese doesn't gain spurious spaces) -- so the ONLY place the space
  // between "Alpha" and "beta" can survive is inside the left piece's own
  // text, exactly what splitAtPointer() now preserves. ---
  const { toggleRowSelection, mergeSelectedSentences } = splitMod;
  toggleRowSelection(left);
  toggleRowSelection(right);
  await mergeSelectedSentences();
  const [remerged] = stateMod.sentences;
  const splitThenMergeResult = {
    remergedText: remerged.text,
    matchesOriginal: remerged.text === text, // must be "Alpha beta" again, not "Alphabeta"
  };

  // --- 3. A plain text-only split (no Azure word data at all) via the
  // synthetic word-gap pointer getSplitPointers()'s textSplitPoints()
  // fallback (split.js) now offers even here: same rule applies. ---
  const s2 = {
    id: crypto.randomUUID(), text: 'One two three', lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: null,
    sourceOffsetMs: null, sourceDurationMs: null, words: null, manualPoints: null,
  };
  setSentences([s2]);
  render();
  const s2Pointer = (getSplitPointers(s2).find((p) => p.charIndex === 4) || null); // "One |two three"
  await splitAtPointer(s2, s2Pointer.charIndex, s2Pointer.ms);
  const [tl, tr] = stateMod.sentences;
  const textOnlyResult = {
    leftText: tl.text,
    rightText: tr.text,
    roundTripsExactly: tl.text + tr.text === 'One two three',
  };

  return { wordSplitResult, splitThenMergeResult, textOnlyResult };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
console.log('LOGS:', logs);
