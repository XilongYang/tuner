// Vocabulary ("生词") CRUD: words/phrases flagged as not understood or
// mispronounced while practicing. One entry per distinct normalized text,
// accumulating a `sources[]` list of occurrences (a sentence + word span it
// was recorded from, each with its own standalone audio clip) across as many
// practice sessions as the same word turns up in -- see normalizeVocabText()
// below for the dedup rule, and mergeVocabEntry() in ../sync/merge.js for how
// two devices' occurrence lists combine during cloud sync.

import { getStore, wrap, VOCAB_STORE } from './db.js';
import { recordTombstone } from './tombstones.js';
import { hashString, hashBlob } from './hashing.js';

/**
 * Normalize text for both the dedup/lookup key and entry storage id: strip
 * whitespace and punctuation/symbols, lowercase. Per Aspen's own rule --
 * exact stated normalization, not a guess. Two recordings of "Hello, world!"
 * and "hello world" collapse to the same entry; a normalization that strips
 * to nothing (pure punctuation/whitespace, shouldn't happen given the picker
 * only ever offers real word spans) is rejected by callers rather than
 * silently creating a blank-id entry.
 */
export function normalizeVocabText(text) {
  return (text || '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

/**
 * Stable, path-safe key for this entry's Azure blob folder (tuner/vocab-audio/<key>/...
 * -- see ../sync/blob-paths.js), computed once at creation and carried
 * through untouched afterward. The entry's own `id` (normalized text) isn't
 * used directly for this -- unlike a session/sentence's random UUID, it can
 * contain characters (e.g. a literal "/" in an unusual phrase, or just
 * arbitrary Unicode) that would need URL-encoding gymnastics -- so this is
 * computed once via the same SHA-256 helper used for content hashing rather
 * than re-derived (and re-encoded) on every sync.
 */
async function computeAudioPathKey(id) {
  return hashString(id);
}

/** Fetch one vocab entry by its normalized-text id (undefined if not found). */
export async function getVocabEntry(id) {
  const store = await getStore('readonly', VOCAB_STORE);
  return wrap(store.get(id));
}

/** List every vocab entry, newest-first by `updatedAt`. */
export async function listVocab() {
  const store = await getStore('readonly', VOCAB_STORE);
  const all = await wrap(store.getAll());
  return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * Record one occurrence of `text` -- creates the entry (first time this
 * normalized text has ever been recorded) or appends to its existing
 * `sources[]` (every later time). Returns the entry actually stored, or null
 * if `text` normalizes to nothing.
 *
 * `source` fields: `sessionId`/`sentenceId` (best-effort "jump to the
 * original session" links -- may point at something since deleted/edited),
 * `sentenceTextSnapshot` (the ORIGINAL sentence's text as it read at record
 * time, so the source is still meaningfully displayable even after the
 * session/sentence it came from is gone), `audioBlob` (the standalone clip
 * for just this word/phrase -- sliced from real audio, or freshly
 * synthesized; see ../sentence-panel/vocab-audio.js). Its Azure path always
 * ends `.audio` regardless of actual format (see blobVocabAudioPath() in
 * ../sync/blob-paths.js) -- playback relies on the Blob's own `type`, set
 * from the upload's Content-Type header, never the path, same convention
 * referenceBlob already uses.
 */
export async function addVocabOccurrence(text, lang, source) {
  const id = normalizeVocabText(text);
  if (!id) return null;
  const now = Date.now();

  const readStore = await getStore('readonly', VOCAB_STORE);
  const existing = await wrap(readStore.get(id));

  // Content-addressed the same way a recording/reference clip is (hashing.js's
  // hashBlob(), already used for exactly that) -- lets a later sync skip
  // re-uploading this occurrence's audio if it's ever re-resolved unchanged.
  const audioHash = source.audioBlob ? await hashBlob(source.audioBlob) : null;

  const occurrence = {
    occurrenceId: source.occurrenceId || crypto.randomUUID(),
    sessionId: source.sessionId ?? null,
    sentenceId: source.sentenceId ?? null,
    sentenceTextSnapshot: source.sentenceTextSnapshot ?? null,
    addedAt: now,
    hasAudio: !!source.audioBlob,
    audioHash,
    // IS persisted into IndexedDB along with everything else on this object
    // (it rides straight into entry.sources below and gets put() as-is) --
    // vocab-panel/panel.js's playRandomOccurrence() depends on that, reading
    // `s.audioBlob` directly off entries returned by listVocab(). Also read
    // straight off this function's own return value by
    // ../sync/azure-sync.js, the same "resolve-then-upload" shape sessions
    // already use for recordingBlob/etc.
    audioBlob: source.audioBlob || null,
  };

  const entry = existing
    ? {
        ...existing,
        // Rewrap every already-stored source's audioBlob into a fresh Blob
        // before re-putting it in this new transaction -- same Chromium
        // "Error preparing Blob/File data to be stored in object store" bug
        // hashing.js's refreshSentenceBlobs()/refreshBlobIfPresent() guard
        // against for sessions; an existing occurrence's Blob was read out in
        // the readStore transaction just above and can't be handed straight
        // back into this readwrite one.
        sources: [
          ...(existing.sources || []).map((s) => (
            s.audioBlob ? { ...s, audioBlob: new Blob([s.audioBlob], { type: s.audioBlob.type }) } : s
          )),
          occurrence,
        ],
        updatedAt: now,
      }
    : {
        id,
        text,
        lang,
        audioPathKey: await computeAudioPathKey(id),
        createdAt: now,
        updatedAt: now,
        sources: [occurrence],
      };

  const writeStore = await getStore('readwrite', VOCAB_STORE);
  await wrap(writeStore.put(entry));
  return entry;
}

/**
 * Merge-write already-resolved vocab entries (from sync). Rewraps every
 * source's audioBlob (same Chromium re-store bug as addVocabOccurrence()
 * above -- a blob resolved from a just-completed download, or read back out
 * of this device's own store during the merge, isn't safe to hand straight
 * into this fresh readwrite transaction).
 */
export async function upsertVocab(entries) {
  if (!entries || !entries.length) return;
  const store = await getStore('readwrite', VOCAB_STORE);
  for (const e of entries) {
    const fresh = {
      ...e,
      sources: (e.sources || []).map((s) => (
        s.audioBlob ? { ...s, audioBlob: new Blob([s.audioBlob], { type: s.audioBlob.type }) } : s
      )),
    };
    await wrap(store.put(fresh));
  }
}

/** Remove a vocab entry's record without touching tombstones -- sync applying someone else's deletion (see tombstones.js's removeSessionRecord() for the same split). */
export async function removeVocabRecord(id) {
  const store = await getStore('readwrite', VOCAB_STORE);
  await wrap(store.delete(id));
}

/** The user's own "delete this vocab entry" action: removes the record and records a tombstone so the deletion sticks through sync. */
export async function deleteVocabEntry(id) {
  const store = await getStore('readwrite', VOCAB_STORE);
  await wrap(store.delete(id));
  await recordTombstone('vocab', id);
}
