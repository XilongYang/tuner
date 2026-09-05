import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');

const result = await page.evaluate(async () => {
  const store = await import('/js/store/index.js');
  const { mergeSession } = await import('/js/sync/merge.js');
  const stateMod = await import('/js/state.js');
  const splitRenderMod = await import('/js/sentence-panel/split-render.js');
  const splitActionsMod = await import('/js/sentence-panel/split-actions.js');
  const splitMod = { ...splitRenderMod, ...splitActionsMod };
  const { setSentences, setCurrentSessionId } = stateMod;
  const { toggleRowSelection, mergeSelectedSentences, render } = splitMod;

  // Reproduce the reported shape: a session with a "pre-split" sentence,
  // saved locally, then split (Merge, to keep this test simple/deterministic
  // -- the same tombstone path splitSentenceAtMarker() uses).
  const oldId = crypto.randomUUID();
  const s1 = {
    id: crypto.randomUUID(), text: 'One.', lang: 'en', hidden: false,
    recorder: new (await import('/js/recorder.js')).Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: null,
  };
  const s2 = {
    id: oldId, text: 'Two.', lang: 'en', hidden: false,
    recorder: new (await import('/js/recorder.js')).Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: null,
  };
  setSentences([s1, s2]);
  render();

  const sessionId = await store.createSession({
    inputText: 'One. Two.',
    splitMode: 'auto',
    sentences: [s1, s2].map(stateMod.sentenceToRecord),
    sourceAudioBlob: null,
    sourceAudioHash: null,
  });
  setCurrentSessionId(sessionId);

  // This is the "remote" snapshot a not-yet-synced device would still have
  // -- the pre-merge two-sentence session.
  const remoteSnapshot = await store.getSession(sessionId);
  const remoteRecord = { ...remoteSnapshot, sentences: remoteSnapshot.sentences.map(stateMod.sentenceToRecord) };

  // Now actually Merge them (the real code path -- records the tombstone).
  toggleRowSelection(s1);
  toggleRowSelection(s2);
  await mergeSelectedSentences();

  // persistSession() (called at the end of mergeSelectedSentences()) saves
  // via a fire-and-forget promise, not awaited by the caller -- read the
  // post-merge state straight from the in-memory `sentences` array (already
  // updated synchronously by setSentences() before persistSession() even
  // starts) rather than racing IndexedDB.
  const tombstones = await store.listTombstones();
  const sentenceTombstones = tombstones.filter((t) => t.kind === 'sentence');

  const localRecord = { ...remoteSnapshot, id: sessionId, sentences: stateMod.sentences.map(stateMod.sentenceToRecord) };
  const tombstoneById = new Map(tombstones.map((t) => [t.id, t]));

  // Simulate exactly what syncWithAzure() does: merge local (post-merge,
  // correct) against remote (pre-merge, stale, as if the other device
  // hasn't synced the Merge yet).
  const merged = mergeSession(localRecord, remoteRecord, tombstoneById);
  const mergedWithoutTombstoneArg = mergeSession(localRecord, remoteRecord); // old behavior, for contrast

  return {
    sentenceTombstoneCount: sentenceTombstones.length,
    tombstonedId: sentenceTombstones[0]?.targetId,
    tombstoneMatchesOldId: sentenceTombstones[0]?.targetId === oldId,
    mergedSentenceCount: merged.sentences.length,
    mergedTexts: merged.sentences.map((s) => s.text),
    oldSentenceResurrected: merged.sentences.some((s) => s.id === oldId),
    // Without the tombstone (old behavior), the stale remote id DOES come back --
    // confirms the test actually exercises the fix, not a no-op.
    oldBehaviorWouldResurrect: mergedWithoutTombstoneArg.sentences.some((s) => s.id === oldId),
  };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
console.log('LOGS:', logs);
