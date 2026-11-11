// Stored bytes, kept apart from the records that reference them and addressed
// by what they are.
//
// A record carries hashes; this store carries what the hashes name, keyed by
// the hash itself. A record reaching its clip asks for the hash it claims, and
// gets exactly those bytes or nothing -- there is no way for the store to
// answer with bytes that are not the ones the record means.
//
// It was keyed by blob path once, the container's own address for the bytes.
// A path is a place, and a place can be rewritten: a sentence recorded again
// lands its new take where the old one was, so for a moment the record said
// one hash and the path held another, and a sync round that had planned
// against the first could pick up the second. Checking the hash on every read
// closed that; keying by the hash removes the question. The path is the
// container's concern (model/content.js builds it from the record), and the
// container is the only place it is needed.
//
// The separation from the record is not a layout preference, and not an
// optimisation. Storing a Blob inside its record means every edit rewrites the
// audio: the record is read back out of IndexedDB on the next page life, and
// saving it hands the engine a Blob that came out of the database to serialize
// back into it. WebKit fails that write, intermittently, with "Error preparing
// Blob/File data to be stored in object store" -- and the failure takes the
// stored copy with it, so the next read of that clip is "NotFoundError: The
// object can not be found here". Measured in Safari 27: a re-stored Blob died
// after 11 stores in one run and 22 in another, while a Blob stored once and
// left alone survived every run. Re-wrapping it first (`new Blob([blob])`) does
// not prevent the failing write; only never handing back a Blob that came out
// of the database does.
//
// Hence the rule this store exists to enforce: bytes are written once, when
// they are produced, and are never part of a record's rewrite. Keying by hash
// makes "once" literal: the same bytes claimed by two records are one entry.

import { CONTENT, transact, request } from './open.js';

/**
 * @typedef {object} ContentEntry
 * @property {string} hash    Content hash of `value`; the key.
 * @property {string} kind    Content kind (see model/content.js).
 * @property {Blob|string|object} value
 * @property {number} storedAt
 */

/** The entry for one hash, or undefined. Sync reads content a slot at a time rather than all at once. */
export async function readOne(hash) {
  return transact([CONTENT], 'readonly', (stores) => (
    request(stores[CONTENT].get(hash), `Reading content ${hash}`)
  ));
}

/**
 * Which of `hashes` the store already holds.
 *
 * This is what makes "write these bytes once" cheap to decide: a save asks
 * which hashes are already here and writes only the rest.
 * @returns {Promise<Set<string>>}
 */
export async function storedHashes(hashes) {
  const wanted = [...new Set(hashes)].filter((hash) => hash != null);
  if (!wanted.length) return new Set();
  return transact([CONTENT], 'readonly', async (stores) => {
    const held = new Set();
    for (const hash of wanted) {
      const key = await request(stores[CONTENT].getKey(hash), `Reading content ${hash}`);
      if (key !== undefined) held.add(hash);
    }
    return held;
  });
}

/**
 * Write entries inside a transaction the caller already owns, so content and
 * the record that references it land together or not at all.
 *
 * Values must already be self-contained -- materialized bytes, a string, a
 * plain object -- because a transaction cannot await a Blob being read. Only
 * the entry's own fields are stored: a caller may carry more beside them (the
 * record an entry arrived for, say) and that is the caller's business.
 */
export function putContentIn(stores, entries, now = Date.now()) {
  return Promise.all(entries.map((entry) => request(
    stores[CONTENT].put({ hash: entry.hash, kind: entry.kind, value: entry.value, storedAt: now }),
    `Storing content ${entry.hash}`,
  )));
}

export function deleteContentIn(stores, hashes) {
  return Promise.all(hashes.map((hash) => request(
    stores[CONTENT].delete(hash),
    `Deleting content ${hash}`,
  )));
}

/**
 * Every hash the store holds. Keys only: no bytes are read.
 *
 * Not used by the app -- collection lists inside its own transaction -- but it
 * is how a test sees what the store actually contains, which is the only way
 * to assert that a save left the audio alone.
 */
export async function listContentHashes() {
  return transact([CONTENT], 'readonly', (stores) => (
    request(stores[CONTENT].getAllKeys(), 'Listing stored content')
  ));
}
