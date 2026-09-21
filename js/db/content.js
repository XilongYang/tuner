// Stored bytes, kept apart from the records that reference them.
//
// A record carries hashes; this store carries what the hashes name, keyed by
// the same blob path the container uses (see model/content.js), so local and
// remote address the same thing the same way.
//
// The separation is not a layout preference, and not an optimisation. Storing
// a Blob inside its record means every edit rewrites the audio: the record is
// read back out of IndexedDB on the next page life, and saving it hands the
// engine a Blob that came out of the database to serialize back into it.
// WebKit fails that write, intermittently, with "Error preparing Blob/File
// data to be stored in object store" -- and the failure takes the stored copy
// with it, so the next read of that clip is "NotFoundError: The object can not
// be found here". Measured in Safari 27: a re-stored Blob died after 11 stores
// in one run and 22 in another, while a Blob stored once and left alone
// survived every run. Re-wrapping it first (`new Blob([blob])`) does not
// prevent the failing write; only never handing back a Blob that came out of
// the database does.
//
// Hence the rule this store exists to enforce: bytes are written once, when
// they are produced, and are never part of a record's rewrite.

import { CONTENT, transact, request } from './open.js';

/**
 * @typedef {object} ContentEntry
 * @property {string} path    Blob path; the key.
 * @property {string} kind    Content kind (see model/content.js).
 * @property {string} hash    Content hash of `value`.
 * @property {Blob|string|object} value
 * @property {number} storedAt
 */

/** One entry, or null. Sync reads content a slot at a time rather than all at once. */
export async function readOne(path) {
  return transact([CONTENT], 'readonly', (stores) => (
    request(stores[CONTENT].get(path), `Reading content at "${path}"`)
  ));
}

/**
 * What the store already holds, as path -> hash.
 *
 * This is what makes "write these bytes once" cheap to decide: a save asks
 * which hashes are already here and writes only the rest.
 */
export async function storedHashes(paths) {
  const wanted = [...new Set(paths)];
  if (!wanted.length) return new Map();
  return transact([CONTENT], 'readonly', async (stores) => {
    const hashes = new Map();
    for (const path of wanted) {
      const entry = await request(stores[CONTENT].get(path), `Reading content at "${path}"`);
      if (entry) hashes.set(path, entry.hash ?? null);
    }
    return hashes;
  });
}

/**
 * Write entries inside a transaction the caller already owns, so content and
 * the record that references it land together or not at all.
 *
 * Values must already be self-contained -- materialized bytes, a string, a
 * plain object -- because a transaction cannot await a Blob being read.
 */
export function putContentIn(stores, entries, now = Date.now()) {
  return Promise.all(entries.map((entry) => request(
    stores[CONTENT].put({ ...entry, storedAt: now }),
    `Storing content at "${entry.path}"`,
  )));
}

export function deleteContentIn(stores, paths) {
  return Promise.all(paths.map((path) => request(
    stores[CONTENT].delete(path),
    `Deleting content at "${path}"`,
  )));
}

/**
 * Every path the store holds. Keys only: no bytes are read.
 *
 * Not used by the app -- the sweep lists inside its own transaction -- but it
 * is how a test sees what the store actually contains, which is the only way
 * to assert that a save left the audio alone.
 */
export async function listContentPaths() {
  return transact([CONTENT], 'readonly', (stores) => (
    request(stores[CONTENT].getAllKeys(), 'Listing stored content')
  ));
}
