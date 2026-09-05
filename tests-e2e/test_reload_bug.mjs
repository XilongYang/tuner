// Regression test for: "刷新页面会导致所有三角消失，并且History里名字变成(empty)"
// (reloading a session wiped its split-pointer triangles and blanked its
// History name). Two independent bugs, both in the reload/persist path
// rather than in split.js's pointer logic itself:
//
// 1. history-panel/session-open.js's makeLiveSentence() (used by both
//    openSession() -- a full reload -- and applyIncomingSessionUpdate())
//    never copied sentence.words/manualPoints onto the live sentence object
//    it builds, even though they were persisted to IndexedDB just fine --
//    so getSplitPointers() had nothing to draw from the moment a session
//    was reopened.
// 2. state.js's persistSession() always saved `inputText: els.input.value`.
//    An audio-imported session locks that textarea read-only and never
//    writes into it (applyAudioSessionLock()), so its .value stays empty --
//    every post-import edit (a triangle-click Split, in particular) was
//    overwriting the session's real inputText with '', which is exactly
//    what made its History entry show "(empty)".
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
  const splitMod = { ...splitRenderMod, ...splitGeometryMod };
  const recorderMod = await import('/js/recorder.js');
  const store = await import('/js/store/index.js');
  const sessionOpenMod = await import('/js/history-panel/session-open.js');
  const { Recorder, encodeWav } = recorderMod;
  const {
    setSentences, setSourceAudio, setCurrentSessionId, setCurrentSplitMode, sentenceToRecord, persistSession,
  } = stateMod;
  const { render, getSplitPointers } = splitMod;
  const { openSession } = sessionOpenMod;

  const sampleRate = 16000;
  const totalMs = 2000;
  const totalSamples = Math.round((totalMs / 1000) * sampleRate);
  const samples = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) samples[i] = 0.5 * Math.sin(i * 0.3);
  const sourceBlob = new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' });
  setSourceAudio(sourceBlob, 'test-hash');

  // Three words -> two INTERIOR pointers (char 6 and char 11), so there's
  // still something to click after a reload.
  const sentence = {
    id: crypto.randomUUID(), text: 'Alpha beta gamma', lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: 'import',
    sourceOffsetMs: 0, sourceDurationMs: totalMs,
    words: [
      { offsetMilliseconds: 0, durationMilliseconds: 600, charStart: 0, charEnd: 5 },
      { offsetMilliseconds: 600, durationMilliseconds: 600, charStart: 6, charEnd: 10 },
      { offsetMilliseconds: 1200, durationMilliseconds: 800, charStart: 11, charEnd: 16 },
    ],
    manualPoints: null,
  };
  setSentences([sentence]);
  // handleAudioImport() (audio-import.js) sets this the same way on a real
  // import -- it's what locks els.input read-only and is what persistSession()
  // (state.js) checks to decide whether els.input.value is meaningful.
  setCurrentSplitMode('audio');

  const sessionId = await store.createSession({
    inputText: sentence.text, splitMode: 'audio',
    sentences: [sentence].map(sentenceToRecord),
    sourceAudioBlob: sourceBlob, sourceAudioHash: 'test-hash',
  });
  setCurrentSessionId(sessionId);
  render();
  await new Promise((r) => setTimeout(r, 100));

  const beforeReload = {
    pointerCountLive: getSplitPointers(stateMod.sentences[0]).length,
    inputTextStored: (await store.getSession(sessionId)).inputText,
  };

  // Any post-import edit (a hide toggle, here -- the cheapest one that still
  // calls persistSession()) must not blank out the session's inputText, since
  // els.input.value is empty for a locked audio session (bug 2).
  splitMod.applyHidden(stateMod.sentences[0], true);
  persistSession();
  await new Promise((r) => setTimeout(r, 100));

  const afterEdit = {
    inputTextStored: (await store.getSession(sessionId)).inputText,
  };

  // Simulate a page refresh: reload the persisted session record straight
  // from IndexedDB and rebuild the on-screen state via openSession() --
  // exactly what History's "open" click, or reopening a previously-saved
  // session, does.
  const persisted = await store.getSession(sessionId);
  openSession(persisted);
  await new Promise((r) => setTimeout(r, 100));

  const afterReload = {
    inputTextStored: persisted.inputText,
    sentenceText: stateMod.sentences[0].text,
    pointerCountAfterReload: getSplitPointers(stateMod.sentences[0]).length,
    domTrianglesRendered: document.querySelectorAll('.split-pointer').length,
  };

  return { beforeReload, afterEdit, afterReload };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
console.log('LOGS:', logs);
