// Core IndexedDB plumbing shared by the rest of js/store: opening/upgrading
// the database, the object store names, and small promise-wrapping helpers.
// Local persistence: practice sessions (and the folders that organize them)
// saved in IndexedDB, entirely inside the browser — nothing here is ever sent
// anywhere. One session corresponds to one Split action; it holds the input
// text and, per sentence, the recording (WAV Blob) and the pronunciation
// assessment. Sessions can be renamed and filed into folders, which can be
// nested arbitrarily deep, so a practice run can be organized and reopened
// later from the History sidebar.

const DB_NAME = 'tuner-sessions';
const DB_VERSION = 3;
export const STORE = 'sessions';
export const FOLDERS_STORE = 'folders';
export const TOMBSTONES_STORE = 'tombstones';

let dbPromise = null;

/** Whether IndexedDB is available in this browser (e.g. unavailable in some private modes). */
export function isSupported() {
  return typeof indexedDB !== 'undefined';
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(FOLDERS_STORE)) {
        const f = db.createObjectStore(FOLDERS_STORE, { keyPath: 'id', autoIncrement: true });
        f.createIndex('parentId', 'parentId');
      }
      if (!db.objectStoreNames.contains(TOMBSTONES_STORE)) {
        // One row per deleted session/folder, keyed by "<kind>:<targetId>" so a
        // session id and a folder id (folders still use small auto-increment
        // numbers) can never collide here. This is what makes a deletion
        // actually stick through sync -- without it, deleting something
        // locally and then syncing just looks like "this device doesn't have
        // it (yet)" to the other side, which brings it right back.
        db.createObjectStore(TOMBSTONES_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function getStore(mode, name = STORE) {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

export function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
