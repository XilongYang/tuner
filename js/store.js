// Local persistence: practice sessions (and the folders that organize them)
// saved in IndexedDB, entirely inside the browser — nothing here is ever sent
// anywhere. One session corresponds to one Split action; it holds the input
// text and, per sentence, the recording (WAV Blob) and the pronunciation
// assessment. Sessions can be renamed and filed into folders, which can be
// nested arbitrarily deep, so a practice run can be organized and reopened
// later from the History sidebar.

const DB_NAME = 'tuner-sessions';
const DB_VERSION = 3;
const STORE = 'sessions';
const FOLDERS_STORE = 'folders';
const TOMBSTONES_STORE = 'tombstones';

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

// ---- Tombstones (deletion tracking for sync) ----

function tombstoneId(kind, targetId) {
  return `${kind}:${targetId}`;
}

/** Record that a session/folder was deleted locally, so sync can propagate the deletion instead of the next pull resurrecting it. */
async function recordTombstone(kind, targetId) {
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

// ---- Sessions ----

/**
 * Create a new session and return its id (a UUID, so it stays globally unique
 * across browsers/devices -- this is what a recording's Azure blob path is
 * keyed on, e.g. tuner/recordings/<sessionId>/<sentenceId>.wav).
 * @param {{ inputText: string, splitMode: string, sentences: Array, folderId?: number|string|null, name?: string|null }} data
 * @returns {Promise<string>}
 */
export async function createSession(data) {
  // stampSentenceVersions() awaits (it hashes any recordings), so it must run
  // BEFORE the write transaction is opened -- an IndexedDB transaction closes
  // itself once control returns to the event loop with no request pending on
  // it, so opening it first and awaiting afterward (as this used to) throws
  // "TransactionInactiveError" the moment add() finally runs.
  const now = Date.now();
  const sentences = await stampSentenceVersions([], data.sentences || []);
  const inputTextHash = data.inputText ? await hashString(data.inputText) : null;
  const store = await getStore('readwrite');
  return wrap(store.add({
    folderId: null,
    name: null,
    ...data,
    sentences,
    // Content hash of inputText, mirroring recordingHash/assessmentHash --
    // cloud sync stores inputText as its own small blob (js/app.js's
    // syncWithAzure()) instead of embedding it in the manifest, since it
    // duplicates the text already spread across `sentences[].text`.
    inputTextHash,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    // Tracks only name / folderId / splitMode / inputText, separately from the
    // per-sentence `updatedAt` fields below and from the session's own general
    // `updatedAt` (which every save bumps, sentence-only edits included) --
    // cloud sync needs this to resolve a rename/move independently of an
    // unrelated recording made moments later on some other device. See
    // updateSession() for how it's maintained.
    metaUpdatedAt: now,
  }));
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

/**
 * SHA-256 of a recording's bytes, as a stand-in for the Blob itself in version
 * comparisons -- refreshSentenceBlobs() above rewraps every recordingBlob into
 * a brand-new Blob instance on every single save (to dodge the Chromium
 * re-store bug), so comparing recordings by object identity or reference is
 * never meaningful here. A cheap hash is the only reliable "did this actually
 * change" signal, and it doubles as the value cloud sync uses to skip
 * re-uploading/re-downloading a recording that's already present unchanged.
 */
async function hashBytes(bufferSource) {
  const digest = await crypto.subtle.digest('SHA-256', bufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashBlob(blob) {
  return hashBytes(await blob.arrayBuffer());
}

/**
 * Same idea as hashBlob(), for the other two "big, mostly-static" payloads
 * that used to be embedded directly in the Azure manifest: a sentence's
 * assessment (word/phoneme-level scores -- by far the largest thing in the
 * old manifest once anything's been scored) and a session's inputText. Both
 * now sync as their own small content-addressed blobs (js/app.js's
 * syncWithAzure()), with only the hash living in the manifest, the same
 * relationship recordings already had to `recordingHash`.
 */
function hashString(str) {
  return hashBytes(new TextEncoder().encode(str));
}

/**
 * Stamp each incoming sentence with a per-sentence `updatedAt`, bumping it only
 * for sentences whose sync-relevant fields (hidden / assessment / recording)
 * actually changed relative to what's currently stored -- this is the version
 * signal cloud sync merges on, at sentence granularity, so editing sentence 3
 * must never touch sentence 1's timestamp (and so, in a merge, never make
 * sentence 1 look newer than it is).
 *
 * recordingHash/assessmentHash are ALWAYS recomputed fresh from the actual
 * content here, never trusted from whatever the incoming sentence happens to
 * carry -- a caller that does `{ ...oldSentence, assessment: newValue }` (the
 * ordinary immutable-update pattern) still has the OLD hash sitting on the
 * object even though the content changed, and trusting that stale hash would
 * silently break both the hash itself and the `changed` check below (which
 * used to compare hashes rather than content for exactly this reason -- see
 * git history if this comment still exists next to that mistake). Hashing a
 * short WAV/JSON payload is cheap enough that "recompute every save" is not
 * worth optimizing away.
 *
 * Known gap: sentences are never added to or removed from a session after
 * Split (see js/app.js's handleSplit) -- so this only has to reconcile
 * field-level edits, never a sentence's disappearance. It also does not (and
 * cannot, without a tombstone) detect a whole *session* being deleted; a sync
 * merge will just see it as "session doesn't exist on this side yet" and
 * bring it back from whichever side still has it.
 */
async function stampSentenceVersions(existingSentences, incomingSentences) {
  if (!Array.isArray(incomingSentences)) return incomingSentences;
  const existingById = new Map((existingSentences || []).map((s) => [s.id, s]));
  const now = Date.now();
  return Promise.all(incomingSentences.map(async (s) => {
    const prev = existingById.get(s.id);

    const recordingHash = s.recordingBlob ? await hashBlob(s.recordingBlob) : null;
    const recordingChanged = (prev?.recordingHash || null) !== (recordingHash || null);

    const assessmentHash = s.assessment ? await hashString(JSON.stringify(s.assessment)) : null;
    const assessmentChanged = (prev?.assessmentHash || null) !== (assessmentHash || null);

    if (!prev) return { ...s, recordingHash, assessmentHash, updatedAt: s.updatedAt ?? now };
    const changed =
      prev.text !== s.text ||
      prev.lang !== s.lang ||
      prev.hidden !== s.hidden ||
      recordingChanged ||
      assessmentChanged;
    return { ...s, recordingHash, assessmentHash, updatedAt: changed ? now : (prev.updatedAt ?? now) };
  }));
}

/** Merge `patch` into an existing session and bump updatedAt. No-op if the id is gone. */
export async function updateSession(id, patch) {
  const readStore = await getStore('readonly');
  const existing = await wrap(readStore.get(id));
  if (!existing) return null;

  const incomingSentences = patch.sentences || existing.sentences;
  // Both of these await, so -- same TransactionInactiveError reason as
  // createSession() -- they must finish before the write transaction below opens.
  const versionedSentences = await stampSentenceVersions(existing.sentences, incomingSentences);
  const inputTextChanged = (patch.inputText ?? existing.inputText) !== existing.inputText;
  const inputTextHash = inputTextChanged
    ? (patch.inputText ? await hashString(patch.inputText) : null)
    : (existing.inputTextHash ?? (existing.inputText ? await hashString(existing.inputText) : null)); // backfill for a session saved before this field existed

  const merged = { ...existing, ...patch, id };
  // metaUpdatedAt tracks only the session's own scalar fields, independently of
  // sentence-only edits (which bump the per-sentence `updatedAt`s above) and of
  // the general `updatedAt` below (bumped on every save, used for "recently
  // used" sorting) -- see createSession() for why this separate signal exists.
  const metaChanged =
    merged.name !== existing.name ||
    (merged.folderId ?? null) !== (existing.folderId ?? null) ||
    merged.splitMode !== existing.splitMode ||
    inputTextChanged;

  const writeStore = await getStore('readwrite');
  const updated = {
    ...merged,
    inputTextHash,
    updatedAt: Date.now(),
    metaUpdatedAt: metaChanged ? Date.now() : (existing.metaUpdatedAt ?? existing.createdAt ?? 0),
    sentences: refreshSentenceBlobs(versionedSentences),
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
  await recordTombstone('session', id);
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

// ---- Non-destructive writes (for incremental cloud sync) ----

/**
 * Write already-merged session/folder records as-is, keyed by their own
 * `id` -- unlike updateSession()/createFolder() etc. this does NOT recompute
 * `updatedAt`/`metaUpdatedAt`/`recordingHash` (the merge in js/app.js has
 * already decided the winning value for each field, sentence by sentence,
 * and re-stamping here would just overwrite that decision) and unlike
 * restoreSnapshot() it does NOT clear the stores first, so anything not
 * mentioned here -- including a session/folder this DB has never seen,
 * created on some other device -- is left untouched.
 */
export async function upsertSessions(sessions) {
  if (!sessions || !sessions.length) return;
  const store = await getStore('readwrite');
  for (const session of sessions) {
    await wrap(store.put({ ...session, sentences: refreshSentenceBlobs(session.sentences) }));
  }
}

/** Folder counterpart to upsertSessions() -- see its docs. */
export async function upsertFolders(folders) {
  if (!folders || !folders.length) return;
  const store = await getStore('readwrite', FOLDERS_STORE);
  for (const folder of folders) {
    await wrap(store.put(folder));
  }
}

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
