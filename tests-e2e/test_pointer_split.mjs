import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');

const result = await page.evaluate(async () => {
  const stateMod = await import('/js/state.js');
  const geometryMod = await import('/js/sentence-panel/split-geometry.js');
  const actionsMod = await import('/js/sentence-panel/split-actions.js');
  const renderMod = await import('/js/sentence-panel/split-render.js');
  const recorderMod = await import('/js/recorder.js');
  const { Recorder, encodeWav } = recorderMod;
  const { setSentences, setSourceAudio } = stateMod;
  const { getSplitPointers } = geometryMod;
  const { splitAtPointer } = actionsMod;
  const { render } = renderMod;

  // 2000ms/16kHz continuous tone with two Azure words: "Alpha" [0,900) and
  // "beta" [900,2000) -- word boundary (a real triangle) sits at char 6
  // ("Alpha " -> "beta"), the sentence text is "Alpha beta".
  const sampleRate = 16000;
  const totalMs = 2000;
  const totalSamples = Math.round((totalMs / 1000) * sampleRate);
  const samples = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) samples[i] = 0.5 * Math.sin(i * 0.3);
  const sourceBlob = new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' });
  setSourceAudio(sourceBlob, 'test-hash');

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

  const pointers = getSplitPointers(sentence);
  // Only char 6 is a valid interior pointer -- char 0 (word 1's own start) is
  // excluded since splitting there would leave the left side empty.
  const pointerShape = pointers.map((p) => ({ charIndex: p.charIndex, ms: p.ms, kind: p.kind }));

  // --- 1. Clicking the exact word-boundary pointer splits instantly, losslessly. ---
  const exact = (getSplitPointers(sentence).find((p) => p.charIndex === 6) || null);
  await splitAtPointer(sentence, exact.charIndex, exact.ms);
  const [left, right] = stateMod.sentences;
  const exactSplitResult = {
    leftText: left.text, rightText: right.text,
    leftOffsetMs: left.sourceOffsetMs, leftDurationMs: left.sourceDurationMs,
    rightOffsetMs: right.sourceOffsetMs, rightDurationMs: right.sourceDurationMs,
    contiguous: left.sourceOffsetMs + left.sourceDurationMs === right.sourceOffsetMs,
  };

  // --- 2. A manual pointer (the kind mergeSelectedSentences() leaves at a
  // seam) is just as exact and splittable via splitAtPointer() as a word
  // pointer -- no fine-tuning step for it either. ---
  const s2 = {
    id: crypto.randomUUID(), text: 'Xa Gamma', lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: 'import',
    sourceOffsetMs: 0, sourceDurationMs: 2000,
    words: [{ offsetMilliseconds: 500, durationMilliseconds: 1500, charStart: 3, charEnd: 8 }],
    manualPoints: [{ offsetMilliseconds: 200, charIndex: 1 }],
  };
  setSentences([s2]);
  render();

  const s2Pointers = getSplitPointers(s2).map((p) => ({ charIndex: p.charIndex, ms: p.ms, kind: p.kind }));
  const manualPointer = (getSplitPointers(s2).find((p) => p.charIndex === 1) || null);
  await splitAtPointer(s2, manualPointer.charIndex, manualPointer.ms);
  const [ml, mr] = stateMod.sentences;
  const manualSplitResult = {
    leftText: ml.text, rightText: mr.text,
    leftOffsetMs: ml.sourceOffsetMs, leftDurationMs: ml.sourceDurationMs,
    rightOffsetMs: mr.sourceOffsetMs, rightDurationMs: mr.sourceDurationMs,
    // The right half ("a Gamma") must keep its "Gamma" word pointer,
    // re-based to its own text -- charStart 3 in the original minus the
    // charIndex(1) split point = 2 ("a Gamma"[2] === 'G').
    rightWordRebased: mr.words && mr.words.length === 1 && mr.words[0].charStart === 2 && mr.words[0].offsetMilliseconds === 500,
    contiguousAt200: ml.sourceOffsetMs === 0 && ml.sourceDurationMs === 200 && mr.sourceOffsetMs === 200,
  };

  // --- 3. A sentence with NO Azure word data at all: getSplitPointers()
  // now falls back to textSplitPoints() (split.js) instead of offering
  // nothing -- one synthetic ('text' kind, no timestamp) pointer per word
  // gap for English. Clicking it goes through the exact same splitAtPointer()
  // as any other pointer, and still clears audio since there's no reliable
  // timing to slice by. ---
  const s3 = {
    id: crypto.randomUUID(), text: 'No word data here', lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: null, referenceUrl: URL.createObjectURL(sourceBlob), referenceHash: null, referenceSource: 'import',
    sourceOffsetMs: 0, sourceDurationMs: 500, words: null, manualPoints: null,
  };
  setSentences([s3]);
  render();
  const s3Pointers = getSplitPointers(s3).map((p) => ({ charIndex: p.charIndex, ms: p.ms, kind: p.kind }));
  const textPointer = (getSplitPointers(s3).find((p) => p.charIndex === 8) || null); // "No word |data here"
  await splitAtPointer(s3, textPointer.charIndex, textPointer.ms);
  const [tl, tr] = stateMod.sentences;
  const textOnlyResult = {
    leftText: tl.text, rightText: tr.text,
    bothAudioCleared: tl.referenceBlob == null && tr.referenceBlob == null
      && tl.sourceOffsetMs == null && tr.sourceOffsetMs == null,
  };

  // --- 4. Same fallback, Japanese: every character boundary gets a point,
  // not just word gaps (Japanese has no spaces to delimit words). ---
  const s4 = {
    id: crypto.randomUUID(), text: 'おはよう', lang: 'ja', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: null,
    sourceOffsetMs: null, sourceDurationMs: null, words: null, manualPoints: null,
  };
  setSentences([s4]);
  render();
  const s4Pointers = getSplitPointers(s4).map((p) => p.charIndex);

  return {
    pointerShape, exactSplitResult, s2Pointers, manualSplitResult, s3Pointers, textOnlyResult, s4Pointers,
  };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
console.log('LOGS:', logs);
