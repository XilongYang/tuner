// Unit coverage for sync/restore.js's restoreFromAzure() -- previously
// untested, for the same reasons as azure-sync.js (see that file's own
// tests/azure-sync.test.mjs module comment): needs `document` to exist just
// to import it, and talks to real Azure. Same two seams here: setup-dom.mjs
// (real jsdom from the actual index.html) and mock.module() swapping
// '../azure-blob.js' for fake-azure-blob.mjs.
//
// Scope: restoreFromAzure() reconstructs local IndexedDB (folders, sessions
// with every blob field, vocab with occurrence audio, tombstones) from
// whatever a manifest + its blobs say -- exercised here by writing a
// manifest directly into the fake container (as if some other client, or an
// earlier azure-sync.js run, had produced it) rather than by driving a real
// upload first.
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

// Dynamic import()s, not static ones -- see azure-sync.test.mjs's module
// comment for exactly why a static import here would silently defeat the
// mock.module() call above.
await import('./setup-indexeddb.mjs');
await import('./setup-dom.mjs');
const { resetStores } = await import('./store-test-helpers.mjs');
const store = await import('../js/store/index.js');
const { saveBlobSasUrl } = await import('../js/config.js');
const { restoreFromAzure } = await import('../js/sync/restore.js');
const {
  BLOB_MANIFEST_PATH, blobRecordingPath, blobInputTextPath, blobVocabAudioPath,
} = await import('../js/sync/blob-paths.js');

const SAS_URL = 'https://fake.blob.core.windows.net/container?sig=x';

beforeEach(async () => {
  await resetStores();
  fakeAzure.resetFakeAzure();
  saveBlobSasUrl(SAS_URL);
  // restoreFromAzure() confirms with the user before replacing local data --
  // stub it to always proceed, same as vocab-panel/panel.js's own
  // deleteEntry() confirm() is stubbed for in tests-e2e/test_vocab_panel.mjs
  // (a real-browser e2e test, not one of this file's unit tests).
  global.confirm = () => true;
});

async function seedManifest(manifest) {
  await fakeAzure.uploadJson(SAS_URL, BLOB_MANIFEST_PATH, manifest);
}

test('restoreFromAzure: replaces local IndexedDB with a session + recording from the manifest and its blobs', async () => {
  const sessionId = 'session-1';
  await fakeAzure.uploadBytes(SAS_URL, blobRecordingPath(sessionId, 'sent-1'), new Uint8Array([1, 2, 3]), 'audio/wav');
  await fakeAzure.uploadBytes(SAS_URL, blobInputTextPath(sessionId), new TextEncoder().encode('restored text'), 'text/plain');
  await seedManifest({
    version: 5,
    folders: [],
    tombstones: [],
    vocab: [],
    sessions: [{
      id: sessionId,
      folderId: null,
      name: null,
      splitMode: 'auto',
      createdAt: 1,
      updatedAt: 2,
      metaUpdatedAt: 2,
      hasInputText: true,
      inputTextHash: 'h1',
      hasSourceAudio: false,
      sourceAudioHash: null,
      sentences: [{
        id: 'sent-1',
        text: 'restored text',
        lang: 'en',
        hidden: false,
        hasRecording: true,
        recordingHash: 'rh1',
        hasAssessment: false,
        assessmentHash: null,
        hasReference: false,
        referenceHash: null,
        referenceSource: null,
        sourceOffsetMs: null,
        sourceDurationMs: null,
        words: null,
        manualPoints: null,
        updatedAt: 2,
      }],
    }],
  });

  // Local has stale, pre-existing data that must be wiped, same as the real
  // "replace ALL local history" behavior this function is named for.
  await store.createSession({ inputText: 'stale local session', splitMode: 'auto', sentences: [] });

  await restoreFromAzure();

  const sessions = await store.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, sessionId);
  assert.equal(sessions[0].inputText, 'restored text');
  assert.equal(sessions[0].sentences.length, 1);
  assert.ok(sessions[0].sentences[0].recordingBlob);
  const bytes = new Uint8Array(await sessions[0].sentences[0].recordingBlob.arrayBuffer());
  assert.deepEqual(Array.from(bytes), [1, 2, 3]);
});

test('restoreFromAzure: reconstructs a vocab entry with its occurrence audio', async () => {
  await fakeAzure.uploadBytes(SAS_URL, blobVocabAudioPath('key1', 'occ-1'), new Uint8Array([9, 8, 7]), 'audio/wav');
  await seedManifest({
    version: 5,
    folders: [],
    tombstones: [],
    sessions: [],
    vocab: [{
      id: 'hello',
      text: 'hello',
      lang: 'en',
      audioPathKey: 'key1',
      createdAt: 1,
      updatedAt: 1,
      sources: [{
        occurrenceId: 'occ-1',
        sessionId: 's1',
        sentenceId: 'sent1',
        sentenceTextSnapshot: 'Hello there.',
        addedAt: 1,
        hasAudio: true,
        audioHash: 'ah1',
      }],
    }],
  });

  await restoreFromAzure();

  const vocab = await store.listVocab();
  assert.equal(vocab.length, 1);
  assert.equal(vocab[0].id, 'hello');
  assert.equal(vocab[0].sources.length, 1);
  assert.ok(vocab[0].sources[0].audioBlob);
  const bytes = new Uint8Array(await vocab[0].sources[0].audioBlob.arrayBuffer());
  assert.deepEqual(Array.from(bytes), [9, 8, 7]);
});

test('restoreFromAzure: an empty remote manifest wipes local history down to nothing', async () => {
  await store.createSession({ inputText: 'will be wiped', splitMode: 'auto', sentences: [] });
  await store.addVocabOccurrence('willbewiped', 'en', {});
  await seedManifest({
    version: 5, folders: [], tombstones: [], vocab: [], sessions: [],
  });

  await restoreFromAzure();

  assert.deepEqual(await store.listSessions(), []);
  assert.deepEqual(await store.listVocab(), []);
});

test('restoreFromAzure: does nothing if the user declines the confirmation', async () => {
  global.confirm = () => false;
  await store.createSession({ inputText: 'must survive', splitMode: 'auto', sentences: [] });
  await seedManifest({
    version: 5, folders: [], tombstones: [], vocab: [], sessions: [],
  });

  await restoreFromAzure();

  const sessions = await store.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].inputText, 'must survive');
});
