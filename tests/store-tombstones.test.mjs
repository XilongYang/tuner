import './setup-indexeddb.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetStores } from './store-test-helpers.mjs';
import {
  recordTombstone, listTombstones, upsertTombstones, removeSessionRecord, removeFolderRecord,
} from '../js/store/tombstones.js';
import { createSession, getSession } from '../js/store/sessions.js';
import { createFolder, listFolders } from '../js/store/folders.js';

beforeEach(resetStores);

test('recordTombstone: ids namespace by kind, so a session and a folder can never collide', async () => {
  await recordTombstone('session', '1');
  await recordTombstone('folder', '1');
  const tombstones = await listTombstones();
  assert.deepEqual(tombstones.map((t) => t.id).sort(), ['folder:1', 'session:1']);
});

test('recordTombstone: re-recording the same kind/id overwrites deletedAt rather than duplicating', async () => {
  await recordTombstone('session', '1');
  const first = (await listTombstones())[0];
  await new Promise((r) => setTimeout(r, 5));
  await recordTombstone('session', '1');
  const all = await listTombstones();
  assert.equal(all.length, 1);
  assert.ok(all[0].deletedAt > first.deletedAt);
});

test('upsertTombstones: writes already-resolved tombstones as-is, without re-stamping deletedAt', async () => {
  await upsertTombstones([{ id: 'session:remote-1', kind: 'session', targetId: 'remote-1', deletedAt: 42 }]);
  const tombstones = await listTombstones();
  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0].deletedAt, 42);
});

test('upsertTombstones: no-op on empty/undefined list', async () => {
  await upsertTombstones([]);
  await upsertTombstones(undefined);
  assert.deepEqual(await listTombstones(), []);
});

test('removeSessionRecord: deletes the session record without touching tombstones', async () => {
  const id = await createSession({ inputText: 'x', splitMode: 'auto', sentences: [] });
  await removeSessionRecord(id);
  assert.equal(await getSession(id), undefined);
  assert.deepEqual(await listTombstones(), []); // unlike deleteSession(), no tombstone is written
});

test('removeFolderRecord: deletes the folder record without touching tombstones', async () => {
  const id = await createFolder({ name: 'x' });
  await removeFolderRecord(id);
  assert.deepEqual(await listFolders(), []);
  assert.deepEqual(await listTombstones(), []);
});
