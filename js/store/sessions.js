// Session CRUD, plus the one-time legacy-data migrations that run at
// startup (UUID ids, inputTextHash backfill).

import { getStore, wrap, openDb, STORE } from './db.js';
import { recordTombstone } from './tombstones.js';
import { refreshSentenceBlobs, stampSentenceVersions, hashString } from './hashing.js';

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

/**
 * One-time backfill for sessions saved before inputTextHash existed.
 * recordingHash/assessmentHash get recomputed fresh on every write via
 * stampSentenceVersions(), but inputTextHash is only computed when
 * createSession()/updateSession() actually runs -- a session that predates
 * this field and hasn't been edited/recorded/scored/renamed since keeps
 * inputTextHash undefined forever otherwise. That matters because
 * syncWithAzure() (js/app.js) treats "no inputTextHash" as "nothing to
 * resolve/sync for this session" and writes the merged result -- inputText
 * included -- back to local storage; a session that reaches that path with a
 * real inputText but no hash gets its perfectly good inputText silently
 * overwritten with null on its very first sync after this feature shipped.
 * Safe to call on every init: a no-op once every session already has a hash.
 */
export async function backfillInputTextHashes() {
  const sessions = await listSessions();
  const stale = sessions.filter((s) => !s.inputTextHash && s.inputText);
  if (!stale.length) return 0;

  // hashString() awaits (SHA-256 via WebCrypto), so every hash must be
  // computed BEFORE the write transaction opens -- an IndexedDB transaction
  // closes itself once control returns to the event loop with no request
  // pending (see the similar note on createSession/updateSession above).
  const hashes = await Promise.all(stale.map((s) => hashString(s.inputText)));

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const objectStore = tx.objectStore(STORE);
    stale.forEach((session, i) => {
      objectStore.put({ ...session, inputTextHash: hashes[i] });
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return stale.length;
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

