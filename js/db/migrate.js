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
// A slot whose bytes cannot be read is reported, not dropped: the record keeps
// the hash, so the clip is still claimed, a sync can still bring it back from
// the container, and the person is told which ones they are. Migration is the
// wrong moment to decide something is worthless.

import { SESSION, FOLDER, VOCAB_ENTRY, walkContent } from '../model/schema.js';
import { contentPath } from '../model/content.js';
import { snapshot, putRecord, stripped } from './entities.js';

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
      }
    }

    // One transaction per record: a library half moved is still half moved
    // forward, and running this again finishes the rest.
    await putRecord(entity, stripped(def, record), entries);
    for (const entry of entries) moved.push(entry.path);
    onProgress({ done: ++done, total: pending.length, entity, id: record.id });
  }

  return { moved, unreadable, records: pending.length };
}
