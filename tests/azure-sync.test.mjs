// Unit coverage for sync/azure-sync.js's syncWithAzure() -- previously
// untested (see entity-schema.js's module comment for why: this file mixes
// content-hash-diffing merge logic with DOM/status-line updates and real
// Azure network calls, and even just IMPORTING it needs `document` to exist,
// since it pulls in state.js's `els` DOM cache at module-evaluation time).
// Made testable here via two seams, neither of which touches azure-sync.js
// itself: setup-dom.mjs (a real jsdom loaded from the actual index.html, so
// `els` resolves) and mock.module() swapping '../azure-blob.js' for
// fake-azure-blob.mjs's in-memory container (so every consumer that talks to
// Azure -- azure-sync.js, sync/lock.js, sync/blob-paths.js's
// cleanupOrphanBlobs() -- runs against fake state instead of the network).
//
// Scope: the merge/upload/download DECISIONS syncWithAzure() makes --
// content-hash diffing, vocab's union merge, tombstone propagation, orphan
// cleanup, and the sync lock -- not azure-blob.js's own HTTP-level behavior
// (headers, XML parsing, timeouts), which stays untested by choice; a fake
// standing in for the network isn't the place to re-verify the real
// network module.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fakeAzure from './fake-azure-blob.mjs';

mock.module('../js/azure-blob.js', {
  namedExports: {
    uploadBytes: fakeAzure.uploadBytes,
    uploadJson: fakeAzure.uploadJson,
    downloadBytes: fakeAzure.downloadBytes,
    downloadJson: fakeAzure.downloadJson,
    downloadJsonConditional: fakeAzure.downloadJsonConditional,
    listBlobs: fakeAzure.listBlobs,
    deleteBlob: fakeAzure.deleteBlob,
  },
});

// Everything below MUST be a dynamic import(), not a static `import`
// statement -- ESM hoists every static import in this file (regardless of
// where it's textually written) so its module is fully loaded and evaluated
// BEFORE this file's own top-level code (including the mock.module() call
// above) ever runs. A static `import '../js/sync/azure-sync.js'` here would
// therefore load the REAL azure-blob.js first, caching it under its
// resolved path before mock.module() got a chance to intercept it -- this
// bit once already (a first version of this file used static imports
// throughout and every test "passed" while silently making real, blocked
// network calls the whole time; only a stricter assertion, and reading the
// real HTTP 403 the egress proxy sent back, caught it). Dynamic import()
// calls, unlike static ones, run exactly where they appear, so awaiting
// them here -- after mock.module() -- is what actually makes the mock take
// effect for these modules and everything they import.
//
// fake-indexeddb/auto (setup-indexeddb.mjs) also auto-detects a `window`
// global and attaches indexedDB to THAT instead of the real Node global
// object if one already exists -- so it must still be awaited before
// setup-dom.mjs defines `global.window`, or db.js's bare `indexedDB`
// reference resolves to nothing on the real global object.
await import('./setup-indexeddb.mjs');
await import('./setup-dom.mjs');
const { resetStores } = await import('./store-test-helpers.mjs');
const store = await import('../js/store/index.js');
const { els } = await import('../js/state.js');
const { saveBlobSasUrl } = await import('../js/config.js');
const { syncWithAzure, findVocabChangedSinceSnapshot } = await import('../js/sync/azure-sync.js');
const {
  setManifestEtagCache, BLOB_MANIFEST_PATH, blobRecordingPath, blobVocabAudioPath,
} = await import('../js/sync/blob-paths.js');

const SAS_URL = 'https://fake.blob.core.windows.net/container?sig=x';

beforeEach(async () => {
  await resetStores();
  fakeAzure.resetFakeAzure();
  // manifestEtagCache is a module-level variable in blob-paths.js, shared by
  // every syncWithAzure() call in this process -- without resetting it, a
  // later test could see a stale cached manifest left over from an earlier
  // one and skip a download it should have made.
  setManifestEtagCache({ etag: null, manifest: null });
  saveBlobSasUrl(SAS_URL);
});

async function remoteManifest() {
  return fakeAzure.fakeAzureBlobs().has(BLOB_MANIFEST_PATH)
    ? JSON.parse(new TextDecoder().decode(fakeAzure.fakeAzureBlobs().get(BLOB_MANIFEST_PATH).bytes))
    : null;
}

test('syncWithAzure: first sync uploads a local session (with a recording) and its inputText to a fresh container', async () => {
  const recordingBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
  const sessionId = await store.createSession({
    inputText: 'hello world',
    splitMode: 'auto',
    sentences: [{ id: 's1', text: 'hello world', lang: 'en', hidden: false, recordingBlob }],
  });

  await syncWithAzure();

  const manifest = await remoteManifest();
  assert.ok(manifest, 'manifest was uploaded');
  assert.equal(manifest.sessions.length, 1);
  assert.equal(manifest.sessions[0].id, sessionId);
  assert.equal(manifest.sessions[0].hasInputText, true);
  assert.equal(manifest.sessions[0].sentences[0].hasRecording, true);

  const recordingPath = blobRecordingPath(sessionId, 's1');
  assert.ok(fakeAzure.fakeAzureBlobs().has(recordingPath), 'recording blob was uploaded');
  const uploadedBytes = fakeAzure.fakeAzureBlobs().get(recordingPath).bytes;
  assert.deepEqual(Array.from(uploadedBytes), [1, 2, 3]);

  assert.match(els.blobActionStatus.textContent, /Sync complete/);
});

test('syncWithAzure: a second device (empty local store) pulls the session and its recording down', async () => {
  const recordingBlob = new Blob([new Uint8Array([4, 5, 6])], { type: 'audio/wav' });
  const sessionId = await store.createSession({
    inputText: 'device A wrote this',
    splitMode: 'auto',
    sentences: [{ id: 's1', text: 'device A wrote this', lang: 'en', hidden: false, recordingBlob }],
  });
  await syncWithAzure(); // "device A" uploads

  // "device B": wipe local as if this were a fresh browser, but keep the fake
  // Azure container and manifest-ETag cache as device A left them.
  await resetStores();
  setManifestEtagCache({ etag: null, manifest: null });

  await syncWithAzure();

  const sessions = await store.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, sessionId);
  assert.equal(sessions[0].inputText, 'device A wrote this');
  assert.equal(sessions[0].sentences.length, 1);
  assert.ok(sessions[0].sentences[0].recordingBlob);
  const bytes = new Uint8Array(await sessions[0].sentences[0].recordingBlob.arrayBuffer());
  assert.deepEqual(Array.from(bytes), [4, 5, 6]);
});

test('syncWithAzure: a no-op second sync re-uploads neither the manifest nor an unchanged recording', async () => {
  const recordingBlob = new Blob([new Uint8Array([7, 7, 7])], { type: 'audio/wav' });
  const sessionId = await store.createSession({
    inputText: 'steady state',
    splitMode: 'auto',
    sentences: [{ id: 's1', text: 'steady state', lang: 'en', hidden: false, recordingBlob }],
  });
  await syncWithAzure();

  const recordingPath = blobRecordingPath(sessionId, 's1');
  const etagAfterFirstSync = fakeAzure.fakeAzureBlobs().get(recordingPath).etag;
  const manifestEtagAfterFirstSync = fakeAzure.fakeAzureBlobs().get(BLOB_MANIFEST_PATH).etag;

  await syncWithAzure();

  assert.equal(fakeAzure.fakeAzureBlobs().get(recordingPath).etag, etagAfterFirstSync, 'recording was not re-uploaded');
  assert.equal(fakeAzure.fakeAzureBlobs().get(BLOB_MANIFEST_PATH).etag, manifestEtagAfterFirstSync, 'manifest was not re-uploaded');
  assert.match(els.blobActionStatus.textContent, /0 uploaded/);
});

test('syncWithAzure: vocab entries merge by UNIONING sources, not last-write-wins', async () => {
  // "Device A": records one occurrence and syncs.
  await store.addVocabOccurrence('word', 'en', {
    occurrenceId: 'occ-a', sessionId: 's1', sentenceId: 'sent1', sentenceTextSnapshot: 'from device A',
  });
  await syncWithAzure();

  // "Device B": never saw device A's occurrence, records a DIFFERENT one for
  // the same word, then syncs against the same (now non-empty) container.
  await resetStores();
  setManifestEtagCache({ etag: null, manifest: null });
  await store.addVocabOccurrence('word', 'en', {
    occurrenceId: 'occ-b', sessionId: 's2', sentenceId: 'sent2', sentenceTextSnapshot: 'from device B',
  });
  await syncWithAzure();

  const vocab = await store.listVocab();
  assert.equal(vocab.length, 1, 'still one entry for the normalized word, not two');
  const occurrenceIds = vocab[0].sources.map((s) => s.occurrenceId).sort();
  assert.deepEqual(occurrenceIds, ['occ-a', 'occ-b'], 'both devices\' occurrences survived the merge');
});

test('syncWithAzure: deleting a session locally propagates as a tombstone, and a second device removes it too', async () => {
  const sessionId = await store.createSession({ inputText: 'to be deleted', splitMode: 'auto', sentences: [] });
  await syncWithAzure(); // device A uploads it
  // Captured before device A's own store gets wiped below, so it can be
  // re-seeded later as "device A's local copy, still un-synced with the
  // deletion" -- store.createSession() always mints its own fresh id
  // (crypto.randomUUID(), ignoring any `id` passed in), so upsertSessions()
  // (a plain put(), id and all) is the only way to put a session back with a
  // SPECIFIC id already known to this test.
  const deviceASession = await store.getSession(sessionId);

  // Device B pulls it down first, so it has something to delete.
  await resetStores();
  setManifestEtagCache({ etag: null, manifest: null });
  await syncWithAzure();
  assert.equal((await store.listSessions()).length, 1, 'device B has the session before deleting it');

  await store.deleteSession(sessionId); // records a tombstone (store/tombstones.js)
  await syncWithAzure(); // device B's deletion propagates to Azure

  assert.deepEqual(await store.listSessions(), [], 'gone locally on device B');
  const manifest = await remoteManifest();
  assert.deepEqual(manifest.sessions, [], 'gone from the manifest too');
  assert.ok(manifest.tombstones.some((t) => t.kind === 'session' && t.targetId === sessionId));

  // Device A, which still has its own (older, pre-deletion) local copy,
  // syncs again and picks up the deletion via the tombstone -- this is the
  // real mechanism a deleted session actually disappears everywhere
  // through, not just on the device that deleted it.
  await resetStores();
  setManifestEtagCache({ etag: null, manifest: null });
  await store.upsertSessions([deviceASession]);
  await syncWithAzure();
  assert.deepEqual(await store.listSessions(), [], 'device A also loses it once it syncs and sees the tombstone');
});

test('syncWithAzure: orphan cleanup removes a recording blob once its sentence is gone from every device\'s manifest', async () => {
  const recordingBlob = new Blob([new Uint8Array([1])], { type: 'audio/wav' });
  const sessionId = await store.createSession({
    inputText: 'x',
    splitMode: 'auto',
    sentences: [{ id: 's1', text: 'x', lang: 'en', hidden: false, recordingBlob }],
  });
  await syncWithAzure();
  const recordingPath = blobRecordingPath(sessionId, 's1');
  assert.ok(fakeAzure.fakeAzureBlobs().has(recordingPath));

  await store.deleteSession(sessionId);
  await syncWithAzure();

  assert.ok(!fakeAzure.fakeAzureBlobs().has(recordingPath), 'orphaned recording blob was cleaned up');
});

test('syncWithAzure: skips the round entirely when another device already holds a non-stale sync lock', async () => {
  await fakeAzure.uploadJson(SAS_URL, 'tuner/sync.lock', { deviceId: 'other-device', acquiredAt: Date.now() }, { ifNoneMatch: '*' });
  await store.createSession({ inputText: 'should not upload', splitMode: 'auto', sentences: [] });

  await syncWithAzure();

  assert.equal(await remoteManifest(), null, 'nothing was uploaded while locked');
  assert.match(els.blobActionStatus.textContent, /locked by other-device/);
});

test('syncWithAzure: deleting a vocab entry locally propagates as a tombstone, and a second device removes it too', async () => {
  await store.addVocabOccurrence('deleteme', 'en', { sessionId: 's1', sentenceId: 'sent1', sentenceTextSnapshot: 'x' });
  await syncWithAzure(); // device A uploads it

  // Device B pulls it down first, so it has something to delete.
  await resetStores();
  setManifestEtagCache({ etag: null, manifest: null });
  await syncWithAzure();
  assert.equal((await store.listVocab()).length, 1, 'device B has the entry before deleting it');

  await store.deleteVocabEntry('deleteme'); // records a tombstone (store/tombstones.js)
  await syncWithAzure(); // device B's deletion propagates to Azure

  assert.deepEqual(await store.listVocab(), [], 'gone locally on device B');
  const manifest = await remoteManifest();
  assert.deepEqual(manifest.vocab, [], 'gone from the manifest too');
  assert.ok(manifest.tombstones.some((t) => t.kind === 'vocab' && t.targetId === 'deleteme'));

  // Device A, which still has its own (older, pre-deletion) local copy,
  // syncs again and picks up the deletion via the tombstone.
  await resetStores();
  setManifestEtagCache({ etag: null, manifest: null });
  await syncWithAzure();
  assert.deepEqual(await store.listVocab(), [], 'device A also loses it once it syncs and sees the tombstone');
});

test('syncWithAzure: uploads a local vocab occurrence\'s audio, and a second device downloads it', async () => {
  const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
  await store.addVocabOccurrence('word', 'en', {
    occurrenceId: 'occ-1', sessionId: 's1', sentenceId: 'sent1', sentenceTextSnapshot: 'x', audioBlob,
  });

  await syncWithAzure();

  const entry = (await store.listVocab())[0];
  const vocabAudioPath = blobVocabAudioPath(entry.audioPathKey, 'occ-1');
  assert.ok(fakeAzure.fakeAzureBlobs().has(vocabAudioPath), 'vocab occurrence audio was uploaded');
  assert.deepEqual(Array.from(fakeAzure.fakeAzureBlobs().get(vocabAudioPath).bytes), [1, 2, 3]);

  // Second device: empty local store, pulls the entry and its audio down.
  await resetStores();
  setManifestEtagCache({ etag: null, manifest: null });
  await syncWithAzure();

  const pulled = (await store.listVocab())[0];
  assert.ok(pulled.sources[0].audioBlob, 'device B has the occurrence audio blob');
  const bytes = new Uint8Array(await pulled.sources[0].audioBlob.arrayBuffer());
  assert.deepEqual(Array.from(bytes), [1, 2, 3]);
});

test('syncWithAzure: a no-op re-sync does not re-upload an unchanged vocab occurrence\'s audio', async () => {
  const audioBlob = new Blob([new Uint8Array([9])], { type: 'audio/wav' });
  await store.addVocabOccurrence('word', 'en', {
    occurrenceId: 'occ-1', sessionId: 's1', sentenceId: 'sent1', sentenceTextSnapshot: 'x', audioBlob,
  });
  await syncWithAzure();
  const entry = (await store.listVocab())[0];
  const vocabAudioPath = blobVocabAudioPath(entry.audioPathKey, 'occ-1');
  const etagAfterFirstSync = fakeAzure.fakeAzureBlobs().get(vocabAudioPath).etag;

  await syncWithAzure();

  assert.equal(fakeAzure.fakeAzureBlobs().get(vocabAudioPath).etag, etagAfterFirstSync, 'vocab audio was not re-uploaded');
});

test('syncWithAzure: orphan cleanup removes a vocab occurrence\'s audio blob once its entry is deleted', async () => {
  const audioBlob = new Blob([new Uint8Array([1])], { type: 'audio/wav' });
  await store.addVocabOccurrence('word', 'en', {
    occurrenceId: 'occ-1', sessionId: 's1', sentenceId: 'sent1', sentenceTextSnapshot: 'x', audioBlob,
  });
  await syncWithAzure();
  const entry = (await store.listVocab())[0];
  const vocabAudioPath = blobVocabAudioPath(entry.audioPathKey, 'occ-1');
  assert.ok(fakeAzure.fakeAzureBlobs().has(vocabAudioPath));

  await store.deleteVocabEntry(entry.id);
  await syncWithAzure();

  assert.ok(!fakeAzure.fakeAzureBlobs().has(vocabAudioPath), 'orphaned vocab audio blob was cleaned up');
});

test('syncWithAzure: a vocab entry deleted locally WHILE a sync is in flight is not resurrected by that sync\'s write-back', async () => {
  // Direct unit coverage for findVocabChangedSinceSnapshot() -- the guard
  // added to close the race where store.deleteVocabEntry() (the vocab
  // panel's own "Delete" button) completes after a sync already read its
  // start-of-round snapshot but before that same sync writes its merge
  // result back, which would otherwise silently resurrect the just-deleted
  // entry for one round (self-correcting on the next sync, but user-visible
  // in the meantime). Exercised directly against a fake getVocabEntryFn
  // rather than by trying to interleave real concurrent IndexedDB calls,
  // which this test harness has no way to force a specific ordering of.
  const snapshot = new Map([['stillthere', 10], ['deletedmidflight', 5], ['editedmidflight', 7]]);
  const fakeGetVocabEntry = async (id) => {
    if (id === 'stillthere') return { id, updatedAt: 10 };
    if (id === 'deletedmidflight') return undefined; // gone -- deleted mid-sync
    if (id === 'editedmidflight') return { id, updatedAt: 999 }; // changed mid-sync
    return undefined;
  };
  const finalVocab = [
    { id: 'stillthere', updatedAt: 10 },
    { id: 'deletedmidflight', updatedAt: 5 },
    { id: 'editedmidflight', updatedAt: 7 },
    { id: 'newfromsync', updatedAt: 1 }, // not in the snapshot -- new this round, never stale
  ];

  const staleIds = await findVocabChangedSinceSnapshot(finalVocab, snapshot, fakeGetVocabEntry);

  assert.deepEqual([...staleIds].sort(), ['deletedmidflight', 'editedmidflight']);
});
