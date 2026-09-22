// Reading and writing entities. Every store-crossing operation is one
// transaction, and every deletion records its tombstone in that same
// transaction, so a record can never be gone locally without the deletion
// having been recorded to propagate.
//
// Record shapes are not described here: they come from model/schema.js.
//
// Records are stored without their content: a stored record carries hashes,
// and the bytes those hashes name live in the content store (see ./content.js
// for why). Reading joins the two back together, so callers above this layer
// see whole records and never have to know where the bytes were. Writing
// separates them again -- and writing *new* bytes is the persist layer's job,
// not this one's, because bytes have to be materialized before a transaction
// can take them.

import {
  SESSIONS, VOCAB, TOMBSTONES, CONTENT, ALL_STORES, transact, request,
} from './open.js';
import { putContentIn, deleteContentIn } from './content.js';
import { tombstoneId } from '../model/merge.js';
import { SESSION, VOCAB_ENTRY, walkContent, hashKey } from '../model/schema.js';
import { contentPath } from '../model/content.js';

// The content store's own reads are part of this module's surface: the app asks
// the database for things, and should not have to know it keeps bytes in a
// second place.
export { readOne as readContent, storedHashes as storedContentHashes, listContentPaths } from './content.js';

/** Which store each collection lives in, its tombstone kind, and its shape. */
const COLLECTIONS = {
  sessions: { store: SESSIONS, kind: 'session', def: SESSION },
  vocab: { store: VOCAB, kind: 'vocab', def: VOCAB_ENTRY },
};

function collection(name) {
  const c = COLLECTIONS[name];
  if (!c) throw new Error(`Unknown collection: ${name}`);
  return c;
}

/** Every blob path a record references, whether or not the bytes are there. */
function contentPathsOf(name, record) {
  if (!record) return [];
  const { def } = collection(name);
  return [...walkContent(def, record)]
    .filter((slot) => slot.hash !== null)
    .map((slot) => contentPath(slot.kind, slot.ref));
}

/**
 * A record as it is stored: hashes kept, values dropped.
 *
 * Only fields the record actually has are touched. Going through `mapContent`
 * would be shorter, but it fills in every field the schema declares, and a
 * partial write would then arrive at the store carrying an empty `sentences`
 * it was never given -- storing a record must not invent the parts of it the
 * caller did not mention.
 */
function stripped(def, record) {
  const out = { ...record };
  for (const [field, d] of def.entries) {
    if (!(field in out)) continue;
    if (d.role === 'content') out[field] = null;
    else if (d.role === 'children') out[field] = (out[field] || []).map((child) => stripped(d.def, child));
  }
  return out;
}

/**
 * A record with its content attached, from entries already read.
 *
 * Fields the record does not have stay absent, for the same reason as in
 * `stripped`: reading is not the place to invent structure.
 *
 * A hash with nothing behind it stays a hash: the record still claims the
 * content, which is what lets a sync fetch it from the container, and what
 * stops a clip whose bytes are missing from quietly becoming a sentence that
 * never had one.
 */
function hydrated(def, record, entries, parentRef = {}) {
  if (!record) return record;
  const ref = def.ref(record, parentRef);
  const out = { ...record };
  for (const [field, d] of def.entries) {
    if (d.role === 'content') {
      if (record[hashKey(field)] == null) continue;
      const entry = entries.get(contentPath(d.kind, ref));
      out[field] = entry ? entry.value : null;
    } else if (d.role === 'children' && field in out) {
      out[field] = (out[field] || []).map((child) => hydrated(d.def, child, entries, ref));
    }
  }
  return out;
}

async function attachContent(def, records, stores) {
  const paths = new Set();
  for (const record of records) {
    for (const slot of walkContent(def, record)) {
      if (slot.hash !== null) paths.add(contentPath(slot.kind, slot.ref));
    }
  }

  const entries = new Map();
  for (const path of paths) {
    const entry = await request(stores[CONTENT].get(path), `Reading content at "${path}"`);
    if (entry) entries.set(path, entry);
  }
  return records.map((record) => hydrated(def, record, entries));
}

export async function getOne(name, id) {
  const { store, def } = collection(name);
  return transact([store, CONTENT], 'readonly', async (stores) => {
    const record = await request(stores[store].get(id), `Reading ${name} ${id}`);
    if (!record) return record;
    const [whole] = await attachContent(def, [record], stores);
    return whole;
  });
}

/**
 * Every record of one kind.
 *
 * `content: false` returns them as stored -- hashes, no bytes -- which is what
 * a caller wants when it is listing rather than opening: hydrating a library of
 * sessions reads every recording in it to show a list of names.
 */
export async function listAll(name, { content = true } = {}) {
  const { store, def } = collection(name);
  return transact([store, CONTENT], 'readonly', async (stores) => {
    const records = await request(stores[store].getAll(), `Listing ${name}`);
    return content ? attachContent(def, records, stores) : records;
  });
}

export async function listTombstones() {
  return transact([TOMBSTONES], 'readonly', (s) => request(s[TOMBSTONES].getAll(), 'Listing tombstones'));
}

/**
 * Everything sync needs to plan a round, read in one consistent transaction.
 *
 * Deliberately not hydrated: planning is arithmetic on hashes, and a round
 * reads the bytes it actually needs one slot at a time, as it uploads them.
 */
export async function snapshot() {
  return transact(ALL_STORES, 'readonly', async (s) => ({
    sessions: await request(s[SESSIONS].getAll(), 'Listing sessions'),
    vocab: await request(s[VOCAB].getAll(), 'Listing vocab'),
    tombstones: await request(s[TOMBSTONES].getAll(), 'Listing tombstones'),
  }));
}

/**
 * Store one record.
 *
 * Content values are dropped on the way in -- what a record claims is its
 * hashes, and the bytes belong to the content store. Putting bytes there is
 * app/persist.js's job, which is where they can be materialized first; a `put`
 * of a record whose hash names content nobody has stored yet is a caller bug,
 * and shows up as a clip that cannot be played rather than as a silent
 * overwrite of one that could.
 */
export async function put(name, record) {
  const { store, def } = collection(name);
  return transact([store], 'readwrite', (s) => (
    request(s[store].put(stripped(def, record)), `Storing ${name} ${record.id}`)
  ));
}

/**
 * Store a record together with content it has brought with it.
 *
 * One transaction, so a record never lands claiming bytes that did not: the
 * hash and what it names become true at the same moment. `entries` carries
 * only what is new -- see app/persist.js, which decides that, and which has
 * already read the bytes into self-contained values, because a transaction
 * cannot wait for a Blob to be read.
 */
export async function putRecord(name, record, entries = []) {
  const { store, def } = collection(name);
  await transact([store, CONTENT], 'readwrite', async (s) => {
    await putContentIn(s, entries);
    await request(s[store].put(stripped(def, record)), `Storing ${name} ${record.id}`);
  });
}

export async function putMany(name, records) {
  if (!records?.length) return;
  const { store, def } = collection(name);
  await transact([store], 'readwrite', async (s) => {
    for (const record of records) {
      await request(s[store].put(stripped(def, record)), `Storing ${name} ${record.id}`);
    }
  });
}

/**
 * The user's own deletion: removes the record, its content and the tombstone
 * that carries the deletion to other devices, atomically. Either all of it
 * lands or none of it does.
 */
export async function remove(name, id, now = Date.now()) {
  const { store, kind } = collection(name);
  await transact([store, TOMBSTONES, CONTENT], 'readwrite', async (s) => {
    const record = await request(s[store].get(id), `Reading ${name} ${id}`);
    await deleteContentIn(s, contentPathsOf(name, record));
    await request(s[store].delete(id), `Deleting ${name} ${id}`);
    await request(
      s[TOMBSTONES].put({ id: tombstoneId(kind, id), kind, targetId: id, deletedAt: now }),
      `Recording the deletion of ${name} ${id}`,
    );
  });
}

/**
 * Applying someone else's deletion, learned from a tombstone that already
 * exists: removes the record without recording a new tombstone, which would
 * re-date the deletion and could resurrect data edited in between.
 */
export async function removeRecord(name, id) {
  const { store } = collection(name);
  await transact([store, CONTENT], 'readwrite', async (s) => {
    const record = await request(s[store].get(id), `Reading ${name} ${id}`);
    await deleteContentIn(s, contentPathsOf(name, record));
    await request(s[store].delete(id), `Deleting ${name} ${id}`);
  });
}

/** Tombstones for sentences replaced by a split or merge; they have no records of their own. */
export async function tombstoneSentences(sentenceIds, now = Date.now()) {
  if (!sentenceIds?.length) return;
  await transact([TOMBSTONES], 'readwrite', async (s) => {
    for (const id of sentenceIds) {
      await request(
        s[TOMBSTONES].put({ id: tombstoneId('sentence', id), kind: 'sentence', targetId: id, deletedAt: now }),
        `Recording the deletion of sentence ${id}`,
      );
    }
  });
}

/**
 * Delete everything, tombstoning every record first so the next sync carries
 * the deletions instead of treating the container's copy as data this device
 * has not seen yet. One transaction for the whole wipe.
 */
export async function clearAll(now = Date.now()) {
  await transact(ALL_STORES, 'readwrite', async (s) => {
    for (const [, { store, kind }] of Object.entries(COLLECTIONS)) {
      const records = await request(s[store].getAll(), 'Listing records to clear');
      for (const record of records) {
        await request(
          s[TOMBSTONES].put({ id: tombstoneId(kind, record.id), kind, targetId: record.id, deletedAt: now }),
          `Recording the deletion of ${record.id}`,
        );
      }
      await request(s[store].clear(), 'Clearing a store');
    }
    await request(s[CONTENT].clear(), 'Clearing stored content');
  });
}

/**
 * Content this device holds that no record references any more -- what a
 * split, a merge or a re-recording leaves behind.
 *
 * The same arithmetic as the container's orphan sweep, on the same paths, and
 * for the same reason: the bytes are only reachable through a record, so bytes
 * no record names are unreachable, and nothing but the storage quota can tell.
 *
 * @returns {Promise<string[]>} the paths deleted
 */
export async function sweepContent() {
  return transact(ALL_STORES, 'readwrite', async (s) => {
    const referenced = new Set();
    for (const [name, { store }] of Object.entries(COLLECTIONS)) {
      const records = await request(s[store].getAll(), `Listing ${name}`);
      for (const record of records) {
        for (const path of contentPathsOf(name, record)) referenced.add(path);
      }
    }

    const held = await request(s[CONTENT].getAllKeys(), 'Listing stored content');
    const orphans = held.filter((path) => !referenced.has(path));
    await deleteContentIn(s, orphans);
    return orphans;
  });
}

/**
 * Apply a sync plan's local writes and deletes in one transaction, skipping any
 * write whose record changed locally since the plan was computed.
 *
 * This is the one staleness check in the app, and it is uniform across every
 * entity kind. In the previous design it was hand-written per kind inside the
 * sync function, which is why the kind added last shipped without it: a vocab
 * entry deleted while a sync was in flight came straight back.
 *
 * `content` is what the round downloaded, already materialized, and lands in
 * the same transaction as the records that reference it -- so a record is never
 * stored claiming bytes that did not make it in beside it. An entry whose
 * owning record is skipped is dropped with it: bytes with no record to reach
 * them through are unreachable, and the next round fetches them again alongside
 * the write that was refused.
 *
 * @param {{localWrites: Array<{entity: string, record: object, baseClock: number|null, id: string}>,
 *          localDeletes: Array<{entity: string, id: string}>,
 *          tombstones: object[]}} plan
 * @param {Record<string, string>} clocks  Collection name -> clock field name.
 * @param {{content?: import('./content.js').ContentEntry[]}} [extra]
 * @returns {Promise<{written: string[], skipped: string[], deleted: string[]}>}
 */
export async function applyPlan(plan, clocks, { content = [] } = {}) {
  return transact(ALL_STORES, 'readwrite', async (s) => {
    const written = [];
    const skipped = [];
    const deleted = [];

    for (const write of plan.localWrites) {
      const { store, def } = collection(write.entity);
      const clockField = clocks[write.entity];
      const current = await request(s[store].get(write.id), `Reading ${write.entity} ${write.id}`);
      const currentClock = current ? (current[clockField] ?? 0) : null;
      if (currentClock !== write.baseClock) {
        // Changed underneath this plan -- most likely the user edited or
        // deleted it while the round-trip was in flight. Leave it alone; the
        // next round plans against the newer state.
        skipped.push(write.id);
        continue;
      }
      await request(s[store].put(stripped(def, write.record)), `Storing ${write.entity} ${write.id}`);
      written.push(write.id);
    }

    const landed = new Set(written);
    await putContentIn(s, content.filter((entry) => landed.has(entry.ownerId)));

    for (const del of plan.localDeletes) {
      const { store } = collection(del.entity);
      const record = await request(s[store].get(del.id), `Reading ${del.entity} ${del.id}`);
      await deleteContentIn(s, contentPathsOf(del.entity, record));
      await request(s[store].delete(del.id), `Deleting ${del.entity} ${del.id}`);
      deleted.push(del.id);
    }

    for (const t of plan.tombstones || []) await request(s[TOMBSTONES].put(t), `Recording tombstone ${t.id}`);

    return { written, skipped, deleted };
  });
}
