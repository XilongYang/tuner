// Deletion tracking for sync: a tombstone is what makes a deletion actually
// stick through cloud sync -- without one, deleting something locally and
// then syncing just looks like "this device doesn't have it (yet)" to the
// other side, which brings it right back.

import { getStore, wrap, FOLDERS_STORE, TOMBSTONES_STORE } from './db.js';

// ---- Tombstones (deletion tracking for sync) ----

function tombstoneId(kind, targetId) {
  return `${kind}:${targetId}`;
}

/** Record that a session/folder was deleted locally, so sync can propagate the deletion instead of the next pull resurrecting it. */
export async function recordTombstone(kind, targetId) {
  const store = await getStore('readwrite', TOMBSTONES_STORE);
  await wrap(store.put({ id: tombstoneId(kind, targetId), kind, targetId, deletedAt: Date.now() }));
}

/** All tombstones this device knows about (own deletions + ones learned from a previous sync). */
export async function listTombstones() {
  const store = await getStore('readonly', TOMBSTONES_STORE);
  return wrap(store.getAll());
}

/** Merge-write already-resolved tombstones (from sync) as-is, without re-stamping `deletedAt`. */
export async function upsertTombstones(tombstones) {
  if (!tombstones || !tombstones.length) return;
  const store = await getStore('readwrite', TOMBSTONES_STORE);
  for (const t of tombstones) await wrap(store.put(t));
}

/**
 * Remove a session/folder record without touching tombstones -- used by
 * cloud-sync merge when a tombstone (local or just learned from Azure) wins
 * over the record's own updatedAt: the merge already decided the tombstone
 * set itself (see js/app.js), this just applies the resulting deletion
 * locally. deleteSession()/deleteFolder() below are for the user's own
 * "Delete" actions and record a fresh tombstone; this is for sync applying
 * someone else's.
 */
export async function removeSessionRecord(id) {
  const store = await getStore('readwrite');
  await wrap(store.delete(id));
}

/** Folder counterpart to removeSessionRecord() -- see its docs. */
export async function removeFolderRecord(id) {
  const store = await getStore('readwrite', FOLDERS_STORE);
  await wrap(store.delete(id));
}
