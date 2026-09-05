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
  const splitActionsMod = await import('/js/sentence-panel/split-actions.js');
  const splitMod = { ...splitRenderMod, ...splitActionsMod };
  const recorderMod = await import('/js/recorder.js');
  const { Recorder, encodeWav, decodeWavPcm16 } = recorderMod;
  const { setSentences, sentences } = stateMod;
  const { toggleRowSelection, mergeSelectedSentences, render } = splitMod;

  function makeImportedSentence(text, sampleCount, fillValue) {
    const samples = new Float32Array(sampleCount).fill(fillValue);
    const blob = new Blob([encodeWav(samples, 16000)], { type: 'audio/wav' });
    return {
      id: crypto.randomUUID(),
      text,
      lang: 'en',
      hidden: false,
      recorder: new Recorder(),
      recordingUrl: null,
      recordingBlob: null,
      recordingHash: null,
      assessment: null,
      referenceBlob: blob,
      referenceUrl: URL.createObjectURL(blob),
      referenceHash: null,
      referenceSource: 'import',
      _importSampleCount: sampleCount,
    };
  }

  const s1 = makeImportedSentence('One.', 1600, 0.1); // 0.1s @16k
  const s2 = makeImportedSentence('Two.', 3200, -0.2); // 0.2s @16k
  const s3 = makeImportedSentence('Three.', 1600, 0.3); // a non-selected trailing sentence

  setSentences([s1, s2, s3]);
  render();

  toggleRowSelection(s1);
  toggleRowSelection(s2);
  await mergeSelectedSentences();

  const merged = stateMod.sentences[0];
  const decodedBuf = await merged.referenceBlob.arrayBuffer();
  const decoded = decodeWavPcm16(decodedBuf);

  return {
    sentenceCount: stateMod.sentences.length,
    mergedText: merged.text,
    mergedReferenceSource: merged.referenceSource,
    mergedSampleRate: decoded.sampleRate,
    mergedSampleCount: decoded.samples.length,
    expectedSampleCount: s1._importSampleCount + s2._importSampleCount,
    // Spot-check the splice: first samples should match s1's fill value,
    // samples after the s1/s2 boundary should match s2's fill value.
    firstSample: decoded.samples[0],
    lastSampleOfFirstClip: decoded.samples[s1._importSampleCount - 1],
    firstSampleOfSecondClip: decoded.samples[s1._importSampleCount],
    lastSample: decoded.samples[decoded.samples.length - 1],
    secondRowText: stateMod.sentences[1] ? stateMod.sentences[1].text : null,
  };
});

console.log(JSON.stringify(result, null, 2));

// Also test the "not all imported" fallback: merge one imported + one plain (no referenceSource).
const result2 = await page.evaluate(async () => {
  const stateMod = await import('/js/state.js');
  const splitRenderMod = await import('/js/sentence-panel/split-render.js');
  const splitActionsMod = await import('/js/sentence-panel/split-actions.js');
  const splitMod = { ...splitRenderMod, ...splitActionsMod };
  const recorderMod = await import('/js/recorder.js');
  const { Recorder, encodeWav } = recorderMod;
  const { setSentences } = stateMod;
  const { toggleRowSelection, mergeSelectedSentences, render } = splitMod;

  const samples = new Float32Array(1600).fill(0.5);
  const blob = new Blob([encodeWav(samples, 16000)], { type: 'audio/wav' });
  const imported = {
    id: crypto.randomUUID(), text: 'Imported.', lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: blob, referenceUrl: URL.createObjectURL(blob), referenceHash: null, referenceSource: 'import',
  };
  const plain = {
    id: crypto.randomUUID(), text: 'Plain.', lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: null,
  };
  setSentences([imported, plain]);
  render();
  toggleRowSelection(imported);
  toggleRowSelection(plain);
  await mergeSelectedSentences();
  const merged = stateMod.sentences[0];
  return {
    sentenceCount: stateMod.sentences.length,
    mergedText: merged.text,
    mergedReferenceBlob: merged.referenceBlob,
    mergedReferenceSource: merged.referenceSource,
  };
});
console.log(JSON.stringify(result2, null, 2));

await browser.close();
console.log('LOGS:', logs);
