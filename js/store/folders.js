// Folder CRUD (reparenting on delete so nothing filed inside is lost),
// full-history clear, and the incremental-sync folder counterpart to
// sessions.js's upsertSessions().

import { getStore, wrap, STORE, FOLDERS_STORE } from './db.js';
import { recordTombstone } from './tombstones.js';
import { listSessions, updateSession } from './sessions.js';

// ---- Folders ----

/**
 * Create a folder and return its id.
 * @param {{ name: string, parentId?: number|null }} data
 * @returns {Promise<number>}
 */
export async function createFolder({ name, parentId = null }) {
  const s = await getStore('readwrite', FOLDERS_STORE);
  const now = Date.now();
  return wrap(s.add({ name, parentId: parentId ?? null, createdAt: now, updatedAt: now }));
}

/** Rename a folder. */
export async function renameFolder(id, name) {
  const readS = await getStore('readonly', FOLDERS_STORE);
  const existing = await wrap(readS.get(id));
  if (!existing) return null;
  const writeS = await getStore('readwrite', FOLDERS_STORE);
  const updated = { ...existing, name, id, updatedAt: Date.now() };
  await wrap(writeS.put(updated));
  return updated;
}

/** Move a folder under a new parent (null = top level). Caller is responsible for cycle-checking. */
export async function moveFolder(id, parentId) {
  const readS = await getStore('readonly', FOLDERS_STORE);
  const existing = await wrap(readS.get(id));
  if (!existing) return null;
  const writeS = await getStore('readwrite', FOLDERS_STORE);
  const updated = { ...existing, parentId: parentId ?? null, id, updatedAt: Date.now() };
  await wrap(writeS.put(updated));
  return updated;
}

/** List all folders (flat; build the tree from `parentId` client-side). */
export async function listFolders() {
  const s = await getStore('readonly', FOLDERS_STORE);
  return wrap(s.getAll());
}

/**
 * Delete a folder. Its direct subfolders and sessions are first reparented to
 * the deleted folder's own parent, so nothing filed inside it is lost.
 */
export async function deleteFolder(id) {
  const [folders, sessions] = await Promise.all([listFolders(), listSessions()]);
  const target = folders.find((f) => f.id === id);
  const newParent = target ? (target.parentId ?? null) : null;

  const childFolders = folders.filter((f) => (f.parentId ?? null) === id);
  const childSessions = sessions.filter((s) => (s.folderId ?? null) === id);

  for (const f of childFolders) await moveFolder(f.id, newParent);
  for (const s of childSessions) await updateSession(s.id, { folderId: newParent });

  const writeS = await getStore('readwrite', FOLDERS_STORE);
  await wrap(writeS.delete(id));
  await recordTombstone('folder', id);
}

/** Delete all sessions and folders. */
export async function clearAll() {
  const s1 = await getStore('readwrite', STORE);
  await wrap(s1.clear());
  const s2 = await getStore('readwrite', FOLDERS_STORE);
  await wrap(s2.clear());
}

/** Folder counterpart to upsertSessions() -- see its docs. */
export async function upsertFolders(folders) {
  if (!folders || !folders.length) return;
  const store = await getStore('readwrite', FOLDERS_STORE);
  for (const folder of folders) {
    await wrap(store.put(folder));
  }
}
