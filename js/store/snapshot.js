// Full-database export/import, for cloud backup and "Restore from Azure".

import { openDb, STORE, FOLDERS_STORE, TOMBSTONES_STORE } from './db.js';
import { listSessions } from './sessions.js';
import { listFolders } from './folders.js';
import { listTombstones } from './tombstones.js';

// ---- Full snapshot export / restore (for cloud backup) ----

/** Read everything — every folder, session and deletion tombstone — for a full backup. */
export async function exportAll() {
  const [folders, sessions, tombstones] = await Promise.all([listFolders(), listSessions(), listTombstones()]);
  return { folders, sessions, tombstones };
}

/**
 * Replace the ENTIRE local database with `snapshot`, preserving each record's
 * original `id` exactly (so parentId/folderId references stay valid) — used to
 * restore a backup. This wipes whatever is currently stored, tombstones
 * included (a manual "Restore from Azure" is meant to make this browser match
 * Azure exactly, so it takes Azure's deletion history too, not just this
 * browser's own).
 */
export async function restoreSnapshot({ folders = [], sessions = [], tombstones = [] } = {}) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, FOLDERS_STORE, TOMBSTONES_STORE], 'readwrite');
    const sessionsStore = tx.objectStore(STORE);
    const foldersStore = tx.objectStore(FOLDERS_STORE);
    const tombstonesStore = tx.objectStore(TOMBSTONES_STORE);
    sessionsStore.clear();
    foldersStore.clear();
    tombstonesStore.clear();
    for (const f of folders) foldersStore.put(f);
    for (const s of sessions) sessionsStore.put(s);
    for (const t of tombstones) tombstonesStore.put(t);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
