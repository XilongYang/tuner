import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');

const result = await page.evaluate(async () => {
  const stateMod = await import('/js/state.js');
  const splitRenderMod = await import('/js/sentence-panel/split-render.js');
  const splitGeometryMod = await import('/js/sentence-panel/split-geometry.js');
  const splitActionsMod = await import('/js/sentence-panel/split-actions.js');
  const splitMod = { ...splitRenderMod, ...splitGeometryMod, ...splitActionsMod };
  const audioImportMod = await import('/js/sentence-panel/audio-decode.js');
  const recorderMod = await import('/js/recorder.js');
  const { Recorder, encodeWav, decodeWavPcm16 } = recorderMod;
  const { setSentences, setSourceAudio } = stateMod;
  const {
    toggleRowSelection, mergeSelectedSentences, splitAtPointer, render, getSplitPointers,
  } = splitMod;
  const { decodeSourceAudio, sliceReferenceClip } = audioImportMod;

  // Build a 3-second, 16kHz "source recording" with a distinctive ramp so we
  // can tell exactly which portion any given slice came from.
  const totalMs = 3000;
  const sampleRate = 16000;
  const totalSamples = Math.round((totalMs / 1000) * sampleRate);
  const sourceSamples = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) sourceSamples[i] = (i / totalSamples) * 2 - 1; // ramp -1..1
  const sourceBlob = new Blob([encodeWav(sourceSamples, sampleRate)], { type: 'audio/wav' });

  setSourceAudio(sourceBlob, 'test-source-hash');

  // Two "imported" sentences covering [0,1000) and [1000,2000) of the source,
  // each carrying one Azure word pointer (mimicking a real import) so the
  // merged sentence has known-exact split points to work with.
  function makeImportedSentence(text, offsetMs, durationMs, words) {
    return {
      id: crypto.randomUUID(), text, lang: 'en', hidden: false, recorder: new Recorder(),
      recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
      referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: 'import',
      sourceOffsetMs: offsetMs, sourceDurationMs: durationMs, words, manualPoints: null,
    };
  }
  // "One." -> single word "One" starting at char 0 (not a valid interior
  // pointer -- charStart must be > 0), plus one further in for realism.
  const s1 = makeImportedSentence('One.', 0, 1000, [
    { offsetMilliseconds: 0, durationMilliseconds: 1000, charStart: 0, charEnd: 3 },
  ]);
  // s2 deliberately carries NO word data of its own (as if it were produced
  // by a manual fine-tune split rather than a fresh Azure import) -- this is
  // exactly the case where the merge seam must be preserved as a manual
  // pointer (decision "A": merge restores it) since nothing else records it.
  const s2 = makeImportedSentence('Two.', 1000, 1000, null);
  const s3 = makeImportedSentence('Three.', 2000, 1000, null); // untouched control

  setSentences([s1, s2, s3]);
  render();

  toggleRowSelection(s1);
  toggleRowSelection(s2);
  await mergeSelectedSentences();

  const afterMerge = stateMod.sentences;
  const merged = afterMerge[0];

  // Ground truth: directly re-slicing [0,2000) from the pristine source.
  const decodedSource = await decodeSourceAudio(sourceBlob);
  const groundTruthMergedBlob = sliceReferenceClip(decodedSource, 0, 2000);
  const groundTruthMergedSamples = decodeWavPcm16(await groundTruthMergedBlob.arrayBuffer()).samples;
  const mergedSamples = decodeWavPcm16(await merged.referenceBlob.arrayBuffer()).samples;

  const mergeMatchesGroundTruth =
    mergedSamples.length === groundTruthMergedSamples.length
    && mergedSamples.every((v, i) => v === groundTruthMergedSamples[i]);

  // Merging "One." + "Two." should have left a manual pointer at the seam
  // (char index 4 -- merged text is "One.Two." with no separator between
  // sentences, and "One." is 4 chars), since s2's own word pointer doesn't
  // start the MERGED text at char 0 the way it started s2's own text.
  const seamPointer = merged.manualPoints && merged.manualPoints.find((p) => p.charIndex === 4 && p.offsetMilliseconds === 1000);

  // Split the merged sentence back apart at that exact seam pointer (the
  // whole point of preserving it -- no waveform fine-tune needed to
  // rediscover the same cut).
  const pointer = (getSplitPointers(merged).find((p) => p.charIndex === 4) || null);
  await splitAtPointer(merged, pointer.charIndex, pointer.ms);

  const afterSplit = stateMod.sentences;
  const [left, right] = afterSplit;

  const splitIsLossless =
    left.sourceOffsetMs === 0 && left.sourceDurationMs === 1000
    && right.sourceOffsetMs === 1000 && right.sourceDurationMs === 1000;

  // Ground truth for the split halves: slice directly from source at the
  // exact same timestamps.
  const gtLeftBlob = sliceReferenceClip(decodedSource, left.sourceOffsetMs, left.sourceDurationMs);
  const gtRightBlob = sliceReferenceClip(decodedSource, right.sourceOffsetMs, right.sourceDurationMs);
  const gtLeftSamples = decodeWavPcm16(await gtLeftBlob.arrayBuffer()).samples;
  const gtRightSamples = decodeWavPcm16(await gtRightBlob.arrayBuffer()).samples;
  const leftSamples = decodeWavPcm16(await left.referenceBlob.arrayBuffer()).samples;
  const rightSamples = decodeWavPcm16(await right.referenceBlob.arrayBuffer()).samples;

  const leftMatchesGroundTruth = leftSamples.length === gtLeftSamples.length && leftSamples.every((v, i) => v === gtLeftSamples[i]);
  const rightMatchesGroundTruth = rightSamples.length === gtRightSamples.length && rightSamples.every((v, i) => v === gtRightSamples[i]);

  return {
    afterMergeCount: afterMerge.length,
    mergedSourceOffsetMs: merged.sourceOffsetMs,
    mergedSourceDurationMs: merged.sourceDurationMs,
    mergeMatchesGroundTruth,
    seamPointerPresent: !!seamPointer,
    afterSplitCount: afterSplit.length,
    leftText: left.text,
    rightText: right.text,
    splitIsLossless,
    leftMatchesGroundTruth,
    rightMatchesGroundTruth,
    thirdSentenceUntouched: afterSplit[2] && afterSplit[2].text === 'Three.' && afterSplit[2].sourceOffsetMs === 2000,
  };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
console.log('LOGS:', logs);
