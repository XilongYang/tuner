// Local persistence: practice sessions (and the folders that organize them)
// saved in IndexedDB, entirely inside the browser — nothing here is ever sent
// anywhere. One session corresponds to one Split action; it holds the input
// text and, per sentence, the recording (WAV Blob) and the pronunciation
// assessment. Sessions can be renamed and filed into folders, which can be
// nested arbitrarily deep, so a practice run can be organized and reopened
// later from the History sidebar.

const DB_NAME = 'tuner-sessions';
const DB_VERSION = 2;
const STORE = 'sessions';
const FOLDERS_STORE = 'folders';

let dbPromise = null;

/** Whether IndexedDB is available in this browser (e.g. unavailable in some private modes). */
export function isSupported() {
  return typeof indexedDB !== 'undefined';
}

function openDb() {
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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function getStore(mode, name = STORE) {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---- Sessions ----

/**
 * Create a new session and return its id (a UUID, so it stays globally unique
 * across browsers/devices -- this is what a recording's Azure blob path is
 * keyed on, e.g. tuner/recordings/<sessionId>/<sentenceId>.wav).
 * @param {{ inputText: string, splitMode: string, sentences: Array, folderId?: number|string|null, name?: string|null }} data
 * @returns {Promise<string>}
 */
export async function createSession(data) {
  const store = await getStore('readwrite');
  const now = Date.now();
  return wrap(store.add({ folderId: null, name: null, ...data, id: crypto.randomUUID(), createdAt: now, updatedAt: now }));
}

/**
 * A Blob read back out of IndexedDB can't always be handed straight back into
 * a later `put()` as-is -- Chromium has a long-standing bug ("Error preparing
 * Blob/File data to be stored in object store") when an already-stored Blob
 * is re-serialized into a *different* transaction, which is exactly what
 * every read-then-write in this file below does (rename, move, reparent on
 * folder delete). Rewrapping it as a fresh in-memory Blob first sidesteps it;
 * this is cheap (no data is copied/read eagerly) and a no-op for blobs that
 * were never touched.
 */
function refreshSentenceBlobs(sentences) {
  if (!Array.isArray(sentences)) return sentences;
  return sentences.map((s) => (
    s && s.recordingBlob
      ? { ...s, recordingBlob: new Blob([s.recordingBlob], { type: s.recordingBlob.type }) }
      : s
  ));
}

/** Merge `patch` into an existing session and bump updatedAt. No-op if the id is gone. */
export async function updateSession(id, patch) {
  const readStore = await getStore('readonly');
  const existing = await wrap(readStore.get(id));
  if (!existing) return null;
  const writeStore = await getStore('readwrite');
  const updated = {
    ...existing,
    ...patch,
    id,
    updatedAt: Date.now(),
    sentences: refreshSentenceBlobs(patch.sentences || existing.sentences),
  };
  await wrap(writeStore.put(updated));
  return updated;
}

/** Rename a session (custom display name); pass a falsy name to clear it back to the text-preview fallback. */
export function renameSession(id, name) {
  return updateSession(id, { name: name || null });
}

/** Move a session into a folder (null = root / no folder). */
export function moveSessionToFolder(id, folderId) {
  return updateSession(id, { folderId: folderId ?? null });
}

/** Fetch one session by id (undefined if not found). */
export async function getSession(id) {
  const store = await getStore('readonly');
  return wrap(store.get(id));
}

/** List all sessions, newest first. */
export async function listSessions() {
  const store = await getStore('readonly');
  const all = await wrap(store.getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Delete one session. */
export async function deleteSession(id) {
  const store = await getStore('readwrite');
  await wrap(store.delete(id));
}

function isUuidId(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * One-time housekeeping: give every local session (and its sentences) that
 * still has a legacy numeric id -- left over from before ids were switched to
 * UUIDs -- a fresh UUID instead, preserving everything else (recordings,
 * scores, folder placement, timestamps). A session's id is what a recording's
 * Azure blob path is keyed on, so this also means the *next* Backup now will
 * re-upload those recordings under their new UUID paths; the old
 * numerically-named blobs on Azure become orphans and get swept up by the
 * existing orphan-recording cleanup on that same backup.
 *
 * IndexedDB keys are immutable in place, so migrating means delete-old +
 * insert-new. A session that's already UUID-keyed is left untouched (this is
 * safe to call on every startup -- it's a fast no-op once nothing is legacy).
 *
 * @returns {Promise<number>} how many sessions were migrated.
 */
export async function migrateSessionIdsToUuid() {
  const sessions = await listSessions();
  const legacy = sessions.filter((s) => !isUuidId(s.id));
  if (!legacy.length) return 0;

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const objectStore = tx.objectStore(STORE);
    for (const session of legacy) {
      const migratedSentences = refreshSentenceBlobs(session.sentences).map((s) => (
        s && !isUuidId(s.id) ? { ...s, id: crypto.randomUUID() } : s
      ));
      objectStore.delete(session.id);
      objectStore.put({ ...session, id: crypto.randomUUID(), sentences: migratedSentences });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return legacy.length;
}

// ---- Folders ----

/**
 * Create a folder and return its id.
 * @param {{ name: string, parentId?: number|null }} data
 * @returns {Promise<number>}
 */
export async function createFolder({ name, parentId = null }) {
  const s = await getStore('readwrite', FOLDERS_STORE);
  return wrap(s.add({ name, parentId: parentId ?? null, createdAt: Date.now() }));
}

/** Rename a folder. */
export async function renameFolder(id, name) {
  const readS = await getStore('readonly', FOLDERS_STORE);
  const existing = await wrap(readS.get(id));
  if (!existing) return null;
  const writeS = await getStore('readwrite', FOLDERS_STORE);
  const updated = { ...existing, name, id };
  await wrap(writeS.put(updated));
  return updated;
}

/** Move a folder under a new parent (null = top level). Caller is responsible for cycle-checking. */
export async function moveFolder(id, parentId) {
  const readS = await getStore('readonly', FOLDERS_STORE);
  const existing = await wrap(readS.get(id));
  if (!existing) return null;
  const writeS = await getStore('readwrite', FOLDERS_STORE);
  const updated = { ...existing, parentId: parentId ?? null, id };
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
}

/** Delete all sessions and folders. */
export async function clearAll() {
  const s1 = await getStore('readwrite', STORE);
  await wrap(s1.clear());
  const s2 = await getStore('readwrite', FOLDERS_STORE);
  await wrap(s2.clear());
}

// ---- Full snapshot export / restore (for cloud backup) ----

/** Read everything — every folder and session, recordings included — for a full backup. */
export async function exportAll() {
  const [folders, sessions] = await Promise.all([listFolders(), listSessions()]);
  return { folders, sessions };
}

/**
 * Replace the ENTIRE local database with `snapshot`, preserving each record's
 * original `id` exactly (so parentId/folderId references stay valid) — used to
 * restore a backup. This wipes whatever is currently stored.
 */
export async function restoreSnapshot({ folders = [], sessions = [] } = {}) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, FOLDERS_STORE], 'readwrite');
    const sessionsStore = tx.objectStore(STORE);
    const foldersStore = tx.objectStore(FOLDERS_STORE);
    sessionsStore.clear();
    foldersStore.clear();
    for (const f of folders) foldersStore.put(f);
    for (const s of sessions) sessionsStore.put(s);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
