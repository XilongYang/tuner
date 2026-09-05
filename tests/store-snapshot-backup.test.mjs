import './setup-indexeddb.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetStores } from './store-test-helpers.mjs';
import { exportAll, restoreSnapshot } from '../js/store/snapshot.js';
import { buildBackupZip, parseBackupZip, freshenImportTimestamps } from '../js/store/backup.js';
import { createSession, getSession, listSessions } from '../js/store/sessions.js';
import { createFolder, listFolders } from '../js/store/folders.js';
import { recordTombstone, listTombstones } from '../js/store/tombstones.js';

beforeEach(resetStores);

test('exportAll: reads back everything currently stored', async () => {
  const folderId = await createFolder({ name: 'F' });
  const sessionId = await createSession({ inputText: 'x', splitMode: 'auto', sentences: [], folderId });
  await recordTombstone('session', 'ghost');

  const snapshot = await exportAll();
  assert.equal(snapshot.folders.length, 1);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].id, sessionId);
  assert.equal(snapshot.tombstones.length, 1);
});

test('restoreSnapshot: replaces the entire database, preserving original ids', async () => {
  // Pre-existing data that restoreSnapshot must wipe.
  await createSession({ inputText: 'will be replaced', splitMode: 'auto', sentences: [] });
  await createFolder({ name: 'will also be replaced' });

  await restoreSnapshot({
    folders: [{ id: 7, name: 'Restored folder', parentId: null, createdAt: 1, updatedAt: 1 }],
    sessions: [{ id: 'restored-session', inputText: 'restored text', sentences: [], createdAt: 1, updatedAt: 1 }],
    tombstones: [{ id: 'session:old', kind: 'session', targetId: 'old', deletedAt: 1 }],
  });

  const folders = await listFolders();
  const sessions = await listSessions();
  const tombstones = await listTombstones();
  assert.equal(folders.length, 1);
  assert.equal(folders[0].id, 7);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'restored-session');
  assert.equal(tombstones.length, 1);
});

test('restoreSnapshot: defaults to an empty database when given no snapshot', async () => {
  await createSession({ inputText: 'x', splitMode: 'auto', sentences: [] });
  await restoreSnapshot();
  assert.deepEqual(await listSessions(), []);
  assert.deepEqual(await listFolders(), []);
  assert.deepEqual(await listTombstones(), []);
});

test('buildBackupZip/parseBackupZip: round-trips folders, sessions and a recording blob', async () => {
  const folderId = await createFolder({ name: 'Backup folder' });
  const recordingBlob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' });
  const sessionId = await createSession({
    inputText: 'round trip me',
    splitMode: 'auto',
    folderId,
    sentences: [{ id: 's1', text: 'round trip me', lang: 'en', hidden: false, recordingBlob }],
  });

  const zipBlob = await buildBackupZip();
  const arrayBuffer = await zipBlob.arrayBuffer();
  const parsed = await parseBackupZip(arrayBuffer);

  assert.equal(parsed.folders.length, 1);
  assert.equal(parsed.folders[0].name, 'Backup folder');
  assert.equal(parsed.sessions.length, 1);
  const session = parsed.sessions[0];
  assert.equal(session.id, sessionId);
  assert.equal(session.inputText, 'round trip me');
  assert.equal(session.sentences.length, 1);
  assert.ok(session.sentences[0].recordingBlob);
  const bytes = new Uint8Array(await session.sentences[0].recordingBlob.arrayBuffer());
  assert.deepEqual(Array.from(bytes), [1, 2, 3, 4]);
});

test('parseBackupZip: rejects a ZIP with no manifest.json', async () => {
  const { makeZip } = await import('../js/zip.js');
  const zip = makeZip([{ name: 'not-manifest.json', data: new Uint8Array([1]) }]);
  const buf = await zip.arrayBuffer();
  await assert.rejects(() => parseBackupZip(buf), /missing manifest\.json/);
});

test('parseBackupZip: rejects an unsupported formatVersion', async () => {
  const { makeZip } = await import('../js/zip.js');
  const manifest = { formatVersion: 999, folders: [], sessions: [], tombstones: [] };
  const zip = makeZip([{ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest)) }]);
  const buf = await zip.arrayBuffer();
  await assert.rejects(() => parseBackupZip(buf), /Unsupported \.tuner backup format version/);
});

test('freshenImportTimestamps: bumps every session/sentence/folder to now, leaves createdAt and tombstones alone', async () => {
  const snapshot = {
    folders: [{ id: 1, name: 'F', updatedAt: 111 }],
    tombstones: [{ id: 'session:x', deletedAt: 5 }],
    sessions: [{
      id: 's1', createdAt: 100, updatedAt: 100, metaUpdatedAt: 100,
      sentences: [{ id: 'w1', updatedAt: 100 }],
    }],
  };
  const before = Date.now();
  const fresh = freshenImportTimestamps(snapshot);

  assert.ok(fresh.folders[0].updatedAt >= before);
  assert.ok(fresh.sessions[0].updatedAt >= before);
  assert.ok(fresh.sessions[0].metaUpdatedAt >= before);
  assert.ok(fresh.sessions[0].sentences[0].updatedAt >= before);
  assert.equal(fresh.sessions[0].createdAt, 100); // untouched
  assert.deepEqual(fresh.tombstones, snapshot.tombstones); // untouched
});
