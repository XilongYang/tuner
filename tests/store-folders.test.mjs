import './setup-indexeddb.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetStores } from './store-test-helpers.mjs';
import {
  createFolder, renameFolder, moveFolder, listFolders, deleteFolder, clearAll, upsertFolders,
} from '../js/store/folders.js';
import { createSession, getSession, listSessions } from '../js/store/sessions.js';
import { listTombstones } from '../js/store/tombstones.js';

beforeEach(resetStores);

test('createFolder: assigns an auto-increment id and stamps timestamps', async () => {
  const id = await createFolder({ name: 'Practice' });
  const [folder] = await listFolders();
  assert.equal(folder.id, id);
  assert.equal(folder.name, 'Practice');
  assert.equal(folder.parentId, null);
  assert.ok(folder.createdAt > 0);
});

test('createFolder: defaults parentId to null when omitted', async () => {
  const id = await createFolder({ name: 'Root child' });
  const [folder] = await listFolders();
  assert.equal(folder.parentId, null);
  assert.equal(id, folder.id);
});

test('renameFolder: updates name and bumps updatedAt; no-op for a missing id', async () => {
  const id = await createFolder({ name: 'Old name' });
  const renamed = await renameFolder(id, 'New name');
  assert.equal(renamed.name, 'New name');
  assert.equal((await listFolders())[0].name, 'New name');

  const missing = await renameFolder(999999, 'x');
  assert.equal(missing, null);
});

test('moveFolder: reparents a folder; null means top-level', async () => {
  const parentId = await createFolder({ name: 'Parent' });
  const childId = await createFolder({ name: 'Child' });
  const moved = await moveFolder(childId, parentId);
  assert.equal(moved.parentId, parentId);

  const movedToRoot = await moveFolder(childId, null);
  assert.equal(movedToRoot.parentId, null);
});

test('deleteFolder: reparents child folders and sessions to the deleted folder\'s own parent', async () => {
  const grandparentId = await createFolder({ name: 'Grandparent' });
  const parentId = await createFolder({ name: 'Parent', parentId: grandparentId });
  const childFolderId = await createFolder({ name: 'Child folder', parentId });
  const sessionId = await createSession({ inputText: 'x', splitMode: 'auto', sentences: [], folderId: parentId });

  await deleteFolder(parentId);

  const folders = await listFolders();
  const childFolder = folders.find((f) => f.id === childFolderId);
  assert.equal(childFolder.parentId, grandparentId); // reparented up to grandparent, not orphaned

  const session = await getSession(sessionId);
  assert.equal(session.folderId, grandparentId);

  assert.equal(folders.find((f) => f.id === parentId), undefined); // the deleted folder itself is gone
});

test('deleteFolder: records a folder tombstone', async () => {
  const id = await createFolder({ name: 'Gone soon' });
  await deleteFolder(id);
  const tombstones = await listTombstones();
  assert.ok(tombstones.some((t) => t.id === `folder:${id}`));
});

test('clearAll: wipes every folder and session, tombstoning each one first', async () => {
  const folderId = await createFolder({ name: 'F' });
  const sessionId = await createSession({ inputText: 'x', splitMode: 'auto', sentences: [] });

  await clearAll();

  assert.deepEqual(await listFolders(), []);
  assert.deepEqual(await listSessions(), []);
  const tombstones = await listTombstones();
  assert.ok(tombstones.some((t) => t.id === `folder:${folderId}`));
  assert.ok(tombstones.some((t) => t.id === `session:${sessionId}`));
});

test('upsertFolders: writes already-merged records as-is; no-op on empty/undefined', async () => {
  await upsertFolders([{ id: 5, name: 'From sync', parentId: null, updatedAt: 123 }]);
  const folders = await listFolders();
  assert.equal(folders.length, 1);
  assert.equal(folders[0].updatedAt, 123); // not recomputed

  await upsertFolders([]);
  await upsertFolders(undefined);
  assert.equal((await listFolders()).length, 1);
});
