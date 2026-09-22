// Moving content out of the records that used to carry it.
//
// The first version of this database stored each Blob inside the record that
// referenced it, so every save rewrote the audio along with the text. That is
// the write the engine intermittently refuses -- and the refusal takes the
// stored copy with it (see ./content.js). Version 2 keeps bytes in their own
// store, and this is the one-time pass that moves what version 1 left behind.
//
// It cannot happen inside the version-change transaction: reading a Blob's
// bytes is asynchronous, and an IndexedDB transaction closes the moment its
// microtask queue drains. So the upgrade creates the store and this runs after
// it, record by record, and is safe to run again -- a record with nothing
// inline is left alone, which is what every record looks like once this has
// been through.
//
// A record with a slot whose bytes cannot be read is left exactly as it is --
// still version 1, bytes still inline -- and reported. It is not rewritten
// without them: `stripped` would take the inline value out of the record, and
// that value is the only copy of those bytes on this device. An unreadable
// Blob is sometimes readable again on a fresh connection, so the next run gets
// another chance at it; a record rewritten without it would have none.
//
// That costs the readable slots of that one record their move as well, which
// is the cheaper mistake: they are still inline, still readable, and still
// claimed by the same hashes, so the only consequence is that this record is
// tried again next time.

import { SESSION, FOLDER, VOCAB_ENTRY, walkContent } from '../model/schema.js';
import { contentPath } from '../model/content.js';
import { initialKeys } from '../model/order.js';
import { snapshot, putRecord, stripped, put, listAll } from './entities.js';

const DEFS = { sessions: SESSION, folders: FOLDER, vocab: VOCAB_ENTRY };

const noop = () => {};
const isBlob = (value) => typeof value?.arrayBuffer === 'function';

/** Content slots that still carry their bytes in the record itself. */
const inlineSlots = (def, record) => [...walkContent(def, record)].filter((slot) => slot.value != null);

/**
 * Move every inline value into the content store.
 *
 * @param {object} deps
 * @param {{materializeBlob: (blob: Blob) => Promise<Blob>}} deps.hash
 * @param {(progress: {done: number, total: number, entity: string, id: string}) => void} [deps.onProgress]
 * @returns {Promise<{moved: string[], unreadable: Array<{path: string, message: string}>, records: number}>}
 */
export async function migrateInlineContent({ hash, onProgress = noop } = {}) {
  const local = await snapshot();

  const pending = [];
  for (const [entity, def] of Object.entries(DEFS)) {
    for (const record of local[entity] || []) {
      const slots = inlineSlots(def, record);
      if (slots.length) pending.push({ entity, def, record, slots });
    }
  }

  const moved = [];
  const unreadable = [];
  let done = 0;

  for (const { entity, def, record, slots } of pending) {
    const entries = [];
    let failed = false;
    for (const slot of slots) {
      const path = contentPath(slot.kind, slot.ref);
      try {
        entries.push({
          path,
          kind: slot.kind,
          hash: slot.hash,
          value: isBlob(slot.value) ? await hash.materializeBlob(slot.value) : slot.value,
        });
      } catch (err) {
        unreadable.push({ path, message: err.message });
        failed = true;
      }
    }

    // Left alone rather than rewritten without the bytes that could not be
    // read: see the header. Skipped, not aborted -- the rest of the library
    // still moves.
    if (failed) {
      onProgress({ done: ++done, total: pending.length, entity, id: record.id, skipped: true });
      continue;
    }

    // One transaction per record: a library half moved is still half moved
    // forward, and running this again finishes the rest.
    await putRecord(entity, stripped(def, record), entries);
    for (const entry of entries) moved.push(entry.path);
    onProgress({ done: ++done, total: pending.length, entity, id: record.id });
  }

  return { moved, unreadable, records: pending.length };
}

/**
 * Give sessions stored before the library had an arrangement a place in it.
 *
 * The order they get is the order they were being shown in when this runs --
 * most recently changed first, which is what the list used to sort itself by.
 * So the first look after the upgrade is the same list the user saw before it,
 * and from then on it only moves when they move it.
 *
 * Idempotent: a session that already has a key keeps it, and the ones without
 * are placed below every key already in use, so running this again -- or
 * running it on a device that has synced a few placed sessions from another --
 * never reshuffles what is already arranged.
 *
 * @returns {Promise<{placed: number}>}
 */
export async function assignSortKeys() {
  const sessions = await listAll('sessions', { content: false });
  const unplaced = sessions.filter((session) => (session.sortKey ?? null) === null);
  if (!unplaced.length) return { placed: 0 };

  unplaced.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  const highest = sessions
    .map((session) => session.sortKey ?? null)
    .filter(Boolean)
    .reduce((high, key) => (high === null || key > high ? key : high), null);
  const keys = initialKeys(unplaced.length, { after: highest });

  for (const [index, session] of unplaced.entries()) {
    // Only the field this is here for. The clocks are left alone deliberately:
    // stamping a position is this device catching up with a schema change, not
    // the user editing the session, and bumping metaUpdatedAt would let it
    // outrank a real edit made on another device.
    await put('sessions', { ...session, sortKey: keys[index] });
  }
  return { placed: unplaced.length };
}
