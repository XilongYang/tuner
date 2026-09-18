// Reading and writing entities. Every store-crossing operation is one
// transaction, and every deletion records its tombstone in that same
// transaction, so a record can never be gone locally without the deletion
// having been recorded to propagate.
//
// Record shapes are not described here: they come from model/schema.js.

import {
  SESSIONS, FOLDERS, VOCAB, TOMBSTONES, ALL_STORES, transact, request,
} from './open.js';
import { tombstoneId } from '../model/merge.js';

/** Which store each collection lives in, and its tombstone kind. */
const COLLECTIONS = {
  sessions: { store: SESSIONS, kind: 'session' },
  folders: { store: FOLDERS, kind: 'folder' },
  vocab: { store: VOCAB, kind: 'vocab' },
};

function collection(name) {
  const c = COLLECTIONS[name];
  if (!c) throw new Error(`Unknown collection: ${name}`);
  return c;
}

export async function getOne(name, id) {
  const { store } = collection(name);
  return transact([store], 'readonly', (s) => request(s[store].get(id)));
}

export async function listAll(name) {
  const { store } = collection(name);
  return transact([store], 'readonly', (s) => request(s[store].getAll()));
}

export async function listTombstones() {
  return transact([TOMBSTONES], 'readonly', (s) => request(s[TOMBSTONES].getAll()));
}

/** Everything sync needs to plan a round, read in one consistent transaction. */
export async function snapshot() {
  return transact(ALL_STORES, 'readonly', async (s) => ({
    sessions: await request(s[SESSIONS].getAll()),
    folders: await request(s[FOLDERS].getAll()),
    vocab: await request(s[VOCAB].getAll()),
    tombstones: await request(s[TOMBSTONES].getAll()),
  }));
}

export async function put(name, record) {
  const { store } = collection(name);
  return transact([store], 'readwrite', (s) => request(s[store].put(record)));
}

export async function putMany(name, records) {
  if (!records?.length) return;
  const { store } = collection(name);
  await transact([store], 'readwrite', async (s) => {
    for (const record of records) await request(s[store].put(record));
  });
}

/**
 * The user's own deletion: removes the record and records the tombstone that
 * carries the deletion to other devices, atomically. Either both land or
 * neither does.
 */
export async function remove(name, id, now = Date.now()) {
  const { store, kind } = collection(name);
  await transact([store, TOMBSTONES], 'readwrite', async (s) => {
    await request(s[store].delete(id));
    await request(s[TOMBSTONES].put({ id: tombstoneId(kind, id), kind, targetId: id, deletedAt: now }));
  });
}

/**
 * Applying someone else's deletion, learned from a tombstone that already
 * exists: removes the record without recording a new tombstone, which would
 * re-date the deletion and could resurrect data edited in between.
 */
export async function removeRecord(name, id) {
  const { store } = collection(name);
  await transact([store], 'readwrite', (s) => request(s[store].delete(id)));
}

/** Tombstones for sentences replaced by a split or merge; they have no records of their own. */
export async function tombstoneSentences(sentenceIds, now = Date.now()) {
  if (!sentenceIds?.length) return;
  await transact([TOMBSTONES], 'readwrite', async (s) => {
    for (const id of sentenceIds) {
      await request(s[TOMBSTONES].put({ id: tombstoneId('sentence', id), kind: 'sentence', targetId: id, deletedAt: now }));
    }
  });
}

export async function putTombstones(tombstones) {
  if (!tombstones?.length) return;
  await transact([TOMBSTONES], 'readwrite', async (s) => {
    for (const t of tombstones) await request(s[TOMBSTONES].put(t));
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
      const records = await request(s[store].getAll());
      for (const record of records) {
        await request(s[TOMBSTONES].put({ id: tombstoneId(kind, record.id), kind, targetId: record.id, deletedAt: now }));
      }
      await request(s[store].clear());
    }
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
 * @param {{localWrites: Array<{entity: string, record: object, baseClock: number|null, id: string}>,
 *          localDeletes: Array<{entity: string, id: string}>,
 *          tombstones: object[]}} plan
 * @param {Record<string, string>} clocks  Collection name -> clock field name.
 * @returns {Promise<{written: string[], skipped: string[], deleted: string[]}>}
 */
export async function applyPlan(plan, clocks) {
  return transact(ALL_STORES, 'readwrite', async (s) => {
    const written = [];
    const skipped = [];
    const deleted = [];

    for (const write of plan.localWrites) {
      const { store } = collection(write.entity);
      const clockField = clocks[write.entity];
      const current = await request(s[store].get(write.id));
      const currentClock = current ? (current[clockField] ?? 0) : null;
      if (currentClock !== write.baseClock) {
        // Changed underneath this plan -- most likely the user edited or
        // deleted it while the round-trip was in flight. Leave it alone; the
        // next round plans against the newer state.
        skipped.push(write.id);
        continue;
      }
      await request(s[store].put(write.record));
      written.push(write.id);
    }

    for (const del of plan.localDeletes) {
      const { store } = collection(del.entity);
      await request(s[store].delete(del.id));
      deleted.push(del.id);
    }

    for (const t of plan.tombstones || []) await request(s[TOMBSTONES].put(t));

    return { written, skipped, deleted };
  });
}
