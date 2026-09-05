// Verifies that splitting an audio-imported sentence at an exact timestamp
// re-slices the reference audio into two correctly-proportioned halves, and
// that a plain (non-import) sentence still discards its reference on split.
//
// Rewritten against the current API: the old splitSentenceAtMarker() (plus
// its _splitMarkerIndex/preview/confirm UI) is gone -- split-actions.js's
// splitAtPointer(sentence, charIndex, ms) now does this directly, immediately,
// no marker/preview state involved (see its doc comment: a pointer IS a real
// timestamp, never a guess needing confirmation). It re-slices from the
// session's shared sourceAudioBlob (state.js), not from the sentence's own
// referenceBlob -- see spliceReferenceAudio()/splitAtPointer() in
// split-actions.js -- so this sets that up via setSourceAudio() instead of
// attaching the ramp directly to the sentence.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');

const result = await page.evaluate(async () => {
  const stateMod = await import('/js/state.js');
  const actionsMod = await import('/js/sentence-panel/split-actions.js');
  const recorderMod = await import('/js/recorder.js');
  const { Recorder, encodeWav, decodeWavPcm16 } = recorderMod;
  const { setSentences, setSourceAudio } = stateMod;
  const { splitAtPointer } = actionsMod;

  const text = 'Hello world.'; // 12 chars, split at charIndex 5 (after "Hello") -> ratio 5/12
  const sampleRate = 16000;
  const totalMs = 750;
  const totalSamples = Math.round((totalMs / 1000) * sampleRate);
  const samples = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) samples[i] = (i / totalSamples) * 2 - 1; // ramp -1..1, distinguishable
  const sourceBlob = new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' });
  setSourceAudio(sourceBlob, 'fake-hash-for-test');

  const sentence = {
    id: crypto.randomUUID(), text, lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: 'import',
    sourceOffsetMs: 0, sourceDurationMs: totalMs,
  };
  setSentences([sentence]);

  const splitMs = totalMs * (5 / 12);
  await splitAtPointer(sentence, 5, splitMs);

  const after = stateMod.sentences;
  const leftBuf = await after[0].referenceBlob.arrayBuffer();
  const rightBuf = await after[1].referenceBlob.arrayBuffer();
  const leftDecoded = decodeWavPcm16(leftBuf);
  const rightDecoded = decodeWavPcm16(rightBuf);

  return {
    sentenceCount: after.length,
    texts: after.map((s) => s.text),
    referenceSources: after.map((s) => s.referenceSource),
    sourceOffsetMs: after.map((s) => s.sourceOffsetMs),
    sourceDurationMs: after.map((s) => s.sourceDurationMs),
    leftSampleCount: leftDecoded.samples.length,
    rightSampleCount: rightDecoded.samples.length,
    expectedLeftRatio: 5 / 12,
    actualLeftRatio: leftDecoded.samples.length / (leftDecoded.samples.length + rightDecoded.samples.length),
    // decoded samples go through encodeWav's normalize(), so exact raw values shift,
    // but sign/relative-order should be preserved: left half should be from the
    // "earlier, more-negative" part of the ramp, right half from the "later" part.
    leftFirstSample: leftDecoded.samples[0],
    leftLastSample: leftDecoded.samples[leftDecoded.samples.length - 1],
    rightFirstSample: rightDecoded.samples[0],
    rightLastSample: rightDecoded.samples[rightDecoded.samples.length - 1],
  };
});

console.log(JSON.stringify(result, null, 2));

// Also verify the non-import (plain) fallback still discards reference on split.
const result2 = await page.evaluate(async () => {
  const stateMod = await import('/js/state.js');
  const actionsMod = await import('/js/sentence-panel/split-actions.js');
  const recorderMod = await import('/js/recorder.js');
  const { Recorder } = recorderMod;
  const { setSentences, setSourceAudio } = stateMod;
  const { splitAtPointer } = actionsMod;

  setSourceAudio(null, null); // no source audio for this plain-text session
  const sentence = {
    id: crypto.randomUUID(), text: 'Plain sentence here.', lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: null,
  };
  setSentences([sentence]);
  await splitAtPointer(sentence, 6, null);
  const after = stateMod.sentences;
  return {
    texts: after.map((s) => s.text),
    referenceBlobs: after.map((s) => s.referenceBlob),
  };
});
console.log(JSON.stringify(result2, null, 2));

await browser.close();
console.log('LOGS:', logs);
