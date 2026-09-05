import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');

const result = await page.evaluate(async () => {
  const store = await import('/js/store/index.js');
  const recorderMod = await import('/js/recorder.js');
  const { encodeWav } = recorderMod;

  const sourceSamples = new Float32Array(16000).fill(0.3); // 1s @16kHz
  const sourceBlob = new Blob([encodeWav(sourceSamples, 16000)], { type: 'audio/wav' });

  const sentenceId = crypto.randomUUID();
  const sessionId = await store.createSession({
    inputText: 'Hello world.',
    splitMode: 'audio',
    sourceAudioBlob: sourceBlob,
    sourceAudioHash: 'abc123',
    sentences: [{
      id: sentenceId,
      text: 'Hello world.',
      lang: 'en',
      hidden: false,
      recordingBlob: null,
      recordingHash: null,
      assessment: null,
      assessmentHash: null,
      referenceBlob: null,
      referenceHash: null,
      referenceSource: 'import',
      sourceOffsetMs: 0,
      sourceDurationMs: 1000,
    }],
  });

  const readBack1 = await store.getSession(sessionId);
  const blob1Bytes = readBack1.sourceAudioBlob ? await readBack1.sourceAudioBlob.arrayBuffer() : null;
  const origBytes = await sourceBlob.arrayBuffer();
  const blob1Matches = blob1Bytes && blob1Bytes.byteLength === origBytes.byteLength;

  // Now simulate a second save (persistSession()'s updateSession path) --
  // this is exactly the code path that would hit the Chromium
  // re-store-Blob bug if refreshBlobIfPresent() weren't applied to
  // sourceAudioBlob.
  await store.updateSession(sessionId, {
    inputText: 'Hello world.',
    splitMode: 'audio',
    sourceAudioBlob: readBack1.sourceAudioBlob,
    sourceAudioHash: readBack1.sourceAudioHash,
    sentences: readBack1.sentences,
  });
  const readBack2 = await store.getSession(sessionId);
  const blob2Bytes = readBack2.sourceAudioBlob ? await readBack2.sourceAudioBlob.arrayBuffer() : null;
  const blob2Matches = blob2Bytes && blob2Bytes.byteLength === origBytes.byteLength;

  // .tuner backup export/import round-trip.
  const zip = await store.buildBackupZip();
  const parsed = await store.parseBackupZip(await zip.arrayBuffer());
  const backedUpSession = parsed.sessions.find((s) => s.id === sessionId);
  const backupBlobBytes = backedUpSession.sourceAudioBlob ? await backedUpSession.sourceAudioBlob.arrayBuffer() : null;
  const backupBlobMatches = backupBlobBytes && backupBlobBytes.byteLength === origBytes.byteLength;

  return {
    sourceAudioHash1: readBack1.sourceAudioHash,
    blob1Matches,
    sentence1: { sourceOffsetMs: readBack1.sentences[0].sourceOffsetMs, sourceDurationMs: readBack1.sentences[0].sourceDurationMs },
    sourceAudioHash2: readBack2.sourceAudioHash,
    blob2Matches,
    backupSourceAudioHash: backedUpSession.sourceAudioHash,
    backupBlobMatches,
    backupSentence: backedUpSession.sentences[0]
      ? { sourceOffsetMs: backedUpSession.sentences[0].sourceOffsetMs, sourceDurationMs: backedUpSession.sentences[0].sourceDurationMs }
      : null,
  };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
console.log('LOGS:', logs);
