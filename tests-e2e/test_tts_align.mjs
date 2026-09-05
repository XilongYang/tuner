// Regression test for: "在每次生成音频时（如 Speak）拿生成的音频去取一下按词
//分组，并且据此生成分段三角和 Speak 高亮" -- tts-player.js's ensureTtsWords()
// gives a plain-text (TTS-backed) sentence real word timestamps the same
// shape as an audio-imported one, row.js's wireWordHighlight() drives a
// karaoke-style highlight off them during Speak playback, and
// mergeSelectedSentences() must NOT blindly carry those words into a merge
// (they're relative to that one sentence's own synthesized clip, not a
// shared timeline) the way it correctly does for real 'import' sentences.
//
// No real Azure calls here (no credentials configured) -- these exercise the
// data-shape/DOM/highlight machinery directly, by constructing sentences
// exactly as ensureTtsWords()/getSplitPointers() would leave them, the same
// way the rest of this suite avoids hitting the network.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');
await page.waitForLoadState('networkidle');

// --- 1. buildTextEl() tags every .row-char with its own data-char-index,
// which wireWordHighlight() needs to map a word's [charStart, charEnd) back
// onto DOM elements. ---
const charIndexResult = await page.evaluate(async () => {
  const stateMod = await import('/js/state.js');
  const splitMod = {
    ...(await import('/js/sentence-panel/split-render.js')),
    ...(await import('/js/sentence-panel/split-geometry.js')),
    ...(await import('/js/sentence-panel/split-actions.js')),
  };
  const recorderMod = await import('/js/recorder.js');
  const { Recorder } = recorderMod;
  const { setSentences } = stateMod;
  const { render } = splitMod;

  const sentence = {
    id: crypto.randomUUID(), text: 'One two', lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: null,
    sourceOffsetMs: null, sourceDurationMs: null, words: null, manualPoints: null,
  };
  setSentences([sentence]);
  render();
  const indices = Array.from(document.querySelectorAll('.row-char'))
    .map((el) => el.dataset.charIndex);
  return { indices, text: sentence.text };
});

// --- 2. Speak playback + real-time highlight: a sentence with a referenceBlob
// (as if a prior Speak already synthesized+aligned it, or a real import) and
// sentence.words already populated should highlight the right .row-char
// spans as playback reaches each word, and clear them once it ends. ---
const highlightResult = await page.evaluate(async () => {
  const stateMod = await import('/js/state.js');
  const splitMod = {
    ...(await import('/js/sentence-panel/split-render.js')),
    ...(await import('/js/sentence-panel/split-geometry.js')),
    ...(await import('/js/sentence-panel/split-actions.js')),
  };
  const recorderMod = await import('/js/recorder.js');
  const { Recorder, encodeWav } = recorderMod;
  const { setSentences } = stateMod;
  const { render } = splitMod;

  // 1.6s / 16kHz tone, split into two words: "Alpha" [0,700) "beta" [900,1600).
  const sampleRate = 16000;
  const totalMs = 1600;
  const samples = new Float32Array(Math.round((totalMs / 1000) * sampleRate));
  for (let i = 0; i < samples.length; i++) samples[i] = 0.4 * Math.sin(i * 0.3);
  const blob = new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' });

  const sentence = {
    id: crypto.randomUUID(), text: 'Alpha beta', lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: blob, referenceUrl: URL.createObjectURL(blob), referenceHash: null, referenceSource: 'tts',
    sourceOffsetMs: null, sourceDurationMs: null,
    words: [
      { offsetMilliseconds: 0, durationMilliseconds: 700, charStart: 0, charEnd: 5 },
      { offsetMilliseconds: 900, durationMilliseconds: 700, charStart: 6, charEnd: 10 },
    ],
    manualPoints: null,
  };
  setSentences([sentence]);
  render();
  return { id: sentence.id };
});

// Click Speak (takes the referenceBlob-cached branch in row.js, which calls
// wireWordHighlight() before playing) and sample the highlighted characters
// partway through each word's real timestamp window.
const playBtn = page.locator('.sentence-row').first().locator('button', { hasText: 'Speak' });
await playBtn.click();
await page.waitForTimeout(300); // inside "Alpha"'s [0,700) window
const duringAlpha = await page.evaluate(() => Array.from(document.querySelectorAll('.row-char.is-speaking')).map((el) => el.textContent).join(''));
await page.waitForTimeout(900); // now inside "beta"'s [900,1600) window (300+900=1200)
const duringBeta = await page.evaluate(() => Array.from(document.querySelectorAll('.row-char.is-speaking')).map((el) => el.textContent).join(''));
await page.waitForTimeout(600); // past the end -- audio (1600ms total) should have ended by now
const afterEnded = await page.evaluate(() => document.querySelectorAll('.row-char.is-speaking').length);

// --- 2b. Same as above, but for a real 'import' sentence: unlike a 'tts'
// sentence (whose referenceUrl clip IS what got transcribed, so its
// words[].offsetMilliseconds are already 0-based within it), an imported
// sentence's words[].offsetMilliseconds are ABSOLUTE within the original
// uploaded recording (audio-import.js's resegmentByPunctuation() never
// rebases them -- getSplitPointers()/splitAtPointer() need that absolute
// value to re-slice from the pristine source), while referenceUrl here is
// already a clip sliced out starting at sourceOffsetMs, so its own
// audio.currentTime runs 0-based. wireWordHighlight() must subtract
// sourceOffsetMs back out before comparing against audio.currentTime, or
// every 'import' sentence with a non-zero sourceOffsetMs highlights nothing
// at all (this was exactly the bug: triangles/splitting worked fine, since
// splitAtPointer() compares against the same absolute timeline the original
// decoded source audio uses, but the highlight compared the SLICE's own
// 0-based playback clock against absolute-in-the-original-recording
// timestamps and never found a match). Reuses the same "Alpha"/"beta" tone,
// but as if this sentence were sliced starting at the 5000ms mark of some
// longer recording -- so its words carry offsets like 5000/5900, not 0/900. ---
const importSourceOffsetMs = 5000;
await page.evaluate(async (base) => {
  const stateMod = await import('/js/state.js');
  const splitMod = {
    ...(await import('/js/sentence-panel/split-render.js')),
    ...(await import('/js/sentence-panel/split-geometry.js')),
    ...(await import('/js/sentence-panel/split-actions.js')),
  };
  const recorderMod = await import('/js/recorder.js');
  const { Recorder, encodeWav } = recorderMod;
  const { setSentences } = stateMod;
  const { render } = splitMod;

  const sampleRate = 16000;
  const totalMs = 1600;
  const samples = new Float32Array(Math.round((totalMs / 1000) * sampleRate));
  for (let i = 0; i < samples.length; i++) samples[i] = 0.4 * Math.sin(i * 0.3);
  const blob = new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' });

  const sentence = {
    id: crypto.randomUUID(), text: 'Alpha beta', lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: blob, referenceUrl: URL.createObjectURL(blob), referenceHash: null, referenceSource: 'import',
    sourceOffsetMs: base, sourceDurationMs: totalMs,
    words: [
      { offsetMilliseconds: base + 0, durationMilliseconds: 700, charStart: 0, charEnd: 5 },
      { offsetMilliseconds: base + 900, durationMilliseconds: 700, charStart: 6, charEnd: 10 },
    ],
    manualPoints: null,
  };
  setSentences([sentence]);
  render();
}, importSourceOffsetMs);

const importPlayBtn = page.locator('.sentence-row').first().locator('button', { hasText: 'Speak' });
await importPlayBtn.click();
await page.waitForTimeout(300); // inside "Alpha"'s clip-relative [0,700) window
const importDuringAlpha = await page.evaluate(() => Array.from(document.querySelectorAll('.row-char.is-speaking')).map((el) => el.textContent).join(''));
await page.waitForTimeout(900); // now inside "beta"'s clip-relative [900,1600) window
const importDuringBeta = await page.evaluate(() => Array.from(document.querySelectorAll('.row-char.is-speaking')).map((el) => el.textContent).join(''));

// --- 3. Language toggle on a 'tts' sentence clears sentence.words along with
// the stale reference audio -- not just the audio fields. Rebuilds a fresh
// 'tts' sentence here (state was left on the 'import' one from step 2b). ---
const langToggleResult = await page.evaluate(async () => {
  const stateMod = await import('/js/state.js');
  const splitMod = {
    ...(await import('/js/sentence-panel/split-render.js')),
    ...(await import('/js/sentence-panel/split-geometry.js')),
    ...(await import('/js/sentence-panel/split-actions.js')),
  };
  const recorderMod = await import('/js/recorder.js');
  const { Recorder, encodeWav } = recorderMod;
  const { setSentences } = stateMod;
  const { render } = splitMod;
  const mod = stateMod;

  const sampleRate = 16000;
  const samples = new Float32Array(Math.round(1.6 * sampleRate));
  const blob = new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' });
  const sentence = {
    id: crypto.randomUUID(), text: 'Alpha beta', lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: blob, referenceUrl: URL.createObjectURL(blob), referenceHash: null, referenceSource: 'tts',
    sourceOffsetMs: null, sourceDurationMs: null,
    words: [
      { offsetMilliseconds: 0, durationMilliseconds: 700, charStart: 0, charEnd: 5 },
      { offsetMilliseconds: 900, durationMilliseconds: 700, charStart: 6, charEnd: 10 },
    ],
    manualPoints: null,
  };
  setSentences([sentence]);
  render();

  const langBtn = sentence._row.querySelector('.lang-toggle');
  langBtn.click();
  return {
    wordsCleared: sentence.words == null,
    referenceClearedToo: sentence.referenceBlob == null && sentence.referenceSource == null,
  };
});

// --- 4. Merge guard: mixing a real 'import' sentence (words on a shared,
// meaningful timeline) with a 'tts' sentence (words relative to its own
// separate clip) must only carry the 'import' one's words into the merge --
// carrying the 'tts' one's too would draw exact-boundary triangles with no
// real (or the wrong) audio behind them. ---
const mergeGuardResult = await page.evaluate(async () => {
  const stateMod = await import('/js/state.js');
  const splitMod = {
    ...(await import('/js/sentence-panel/split-render.js')),
    ...(await import('/js/sentence-panel/split-geometry.js')),
    ...(await import('/js/sentence-panel/split-actions.js')),
  };
  const recorderMod = await import('/js/recorder.js');
  const { Recorder, encodeWav } = recorderMod;
  const { setSentences, setSourceAudio } = stateMod;
  const { toggleRowSelection, mergeSelectedSentences, render, getSplitPointers } = splitMod;

  const sampleRate = 16000;
  const importSamples = new Float32Array(Math.round(1 * sampleRate));
  const sourceBlob = new Blob([encodeWav(importSamples, sampleRate)], { type: 'audio/wav' });
  setSourceAudio(sourceBlob, 'test-hash');

  const importSentence = {
    id: crypto.randomUUID(), text: 'One', lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: new Blob([encodeWav(importSamples, sampleRate)], { type: 'audio/wav' }),
    referenceUrl: URL.createObjectURL(new Blob([encodeWav(importSamples, sampleRate)], { type: 'audio/wav' })),
    referenceHash: null, referenceSource: 'import',
    sourceOffsetMs: 0, sourceDurationMs: 1000,
    words: [{ offsetMilliseconds: 0, durationMilliseconds: 1000, charStart: 0, charEnd: 3 }],
    manualPoints: null,
  };
  const ttsSamples = new Float32Array(Math.round(0.8 * sampleRate));
  const ttsSentence = {
    id: crypto.randomUUID(), text: 'Two', lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: new Blob([encodeWav(ttsSamples, sampleRate)], { type: 'audio/wav' }),
    referenceUrl: URL.createObjectURL(new Blob([encodeWav(ttsSamples, sampleRate)], { type: 'audio/wav' })),
    referenceHash: null, referenceSource: 'tts',
    sourceOffsetMs: null, sourceDurationMs: null,
    // Own separate clip's own 0-based timeline -- NOT the source-file
    // timeline importSentence's words are on.
    words: [{ offsetMilliseconds: 0, durationMilliseconds: 800, charStart: 0, charEnd: 3 }],
    manualPoints: null,
  };
  setSentences([importSentence, ttsSentence]);
  render();

  toggleRowSelection(importSentence);
  toggleRowSelection(ttsSentence);
  await mergeSelectedSentences();
  const [merged] = stateMod.sentences;
  const pointers = getSplitPointers(merged).map((p) => ({ charIndex: p.charIndex, kind: p.kind }));
  return {
    mergedText: merged.text,
    // Only importSentence's one word (charStart 0-3, "One") should be
    // present, re-based; nothing from ttsSentence's own words[].
    wordsCount: merged.words ? merged.words.length : 0,
    words: merged.words,
    pointers,
  };
});

console.log(JSON.stringify({
  charIndexResult, highlightResult,
  duringAlpha, duringBeta, afterEnded,
  importDuringAlpha, importDuringBeta,
  langToggleResult, mergeGuardResult,
}, null, 2));

await browser.close();
console.log('LOGS:', logs);
