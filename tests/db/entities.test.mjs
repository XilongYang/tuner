import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getOne, listAll, listTombstones, snapshot, put, putMany,
  remove, removeRecord, tombstoneSentences, clearAll, applyPlan,
} from '../../js/db/entities.js';
import { transact, ALL_STORES, request } from '../../js/db/open.js';

const CLOCKS = { sessions: 'updatedAt', folders: 'updatedAt', vocab: 'updatedAt' };

beforeEach(async () => {
  await transact(ALL_STORES, 'readwrite', async (s) => {
    for (const name of ALL_STORES) await request(s[name].clear());
  });
});

test('put/getOne/listAll round-trip a record unchanged', async () => {
  await put('sessions', { id: 's1', name: 'One', updatedAt: 5 });
  assert.deepEqual(await getOne('sessions', 's1'), { id: 's1', name: 'One', updatedAt: 5 });
  assert.equal((await listAll('sessions')).length, 1);
});

test('putMany is a no-op on an empty list rather than an error', async () => {
  await putMany('sessions', []);
  await putMany('sessions', undefined);
  assert.deepEqual(await listAll('sessions'), []);
});

test('an unknown collection fails loudly instead of silently doing nothing', async () => {
  await assert.rejects(() => put('nonsense', { id: 1 }), /Unknown collection/);
});

test('remove deletes the record AND records its tombstone in one step', async () => {
  await put('vocab', { id: 'word', updatedAt: 1 });
  await remove('vocab', 'word', 4242);

  assert.equal(await getOne('vocab', 'word'), undefined);
  assert.deepEqual(await listTombstones(), [
    { id: 'vocab:word', kind: 'vocab', targetId: 'word', deletedAt: 4242 },
  ]);
});

test('removeRecord applies someone else\'s deletion without re-dating it', async () => {
  await put('sessions', { id: 's1', updatedAt: 1 });
  await removeRecord('sessions', 's1');
  assert.equal(await getOne('sessions', 's1'), undefined);
  assert.deepEqual(await listTombstones(), [], 'no new tombstone: the deletion is already recorded elsewhere');
});

test('tombstoneSentences records replacements for sentences that have no record of their own', async () => {
  await tombstoneSentences(['a', 'b'], 100);
  assert.deepEqual((await listTombstones()).map((t) => t.id).sort(), ['sentence:a', 'sentence:b']);
});

test('clearAll wipes every collection and tombstones every record first', async () => {
  await put('sessions', { id: 's1', updatedAt: 1 });
  await put('folders', { id: 'f1', updatedAt: 1 });
  await put('vocab', { id: 'v1', updatedAt: 1 });

  await clearAll(777);

  assert.deepEqual(await listAll('sessions'), []);
  assert.deepEqual(await listAll('folders'), []);
  assert.deepEqual(await listAll('vocab'), []);
  assert.deepEqual((await listTombstones()).map((t) => t.id).sort(), ['folder:f1', 'session:s1', 'vocab:v1']);
});

test('snapshot reads every collection in one consistent view', async () => {
  await put('sessions', { id: 's1', updatedAt: 1 });
  await put('vocab', { id: 'v1', updatedAt: 1 });
  const snap = await snapshot();
  assert.deepEqual(Object.keys(snap).sort(), ['folders', 'sessions', 'tombstones', 'vocab']);
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.vocab.length, 1);
});

test('applyPlan writes records whose clock still matches the plan', async () => {
  await put('sessions', { id: 's1', name: 'old', updatedAt: 10 });
  const result = await applyPlan({
    localWrites: [{ entity: 'sessions', id: 's1', baseClock: 10, record: { id: 's1', name: 'merged', updatedAt: 20 } }],
    localDeletes: [],
    tombstones: [],
  }, CLOCKS);

  assert.deepEqual(result, { written: ['s1'], skipped: [], deleted: [] });
  assert.equal((await getOne('sessions', 's1')).name, 'merged');
});

test('applyPlan refuses a write whose record changed since the plan was made', async () => {
  // The in-flight edit case: the plan was computed from updatedAt 10, the user
  // edited it to 99 while the network round-trip was happening.
  await put('sessions', { id: 's1', name: 'user edit', updatedAt: 99 });
  const result = await applyPlan({
    localWrites: [{ entity: 'sessions', id: 's1', baseClock: 10, record: { id: 's1', name: 'stale merge', updatedAt: 20 } }],
    localDeletes: [],
    tombstones: [],
  }, CLOCKS);

  assert.deepEqual(result.skipped, ['s1']);
  assert.equal((await getOne('sessions', 's1')).name, 'user edit', 'the newer local edit survives');
});

test('applyPlan refuses to resurrect a record deleted while the sync was in flight', async () => {
  // Same guard, and the specific bug it exists for: the plan says to write a
  // vocab entry the user deleted moments ago. Its clock is now absent, which
  // does not match the clock the plan was built from.
  const result = await applyPlan({
    localWrites: [{ entity: 'vocab', id: 'word', baseClock: 10, record: { id: 'word', updatedAt: 10 } }],
    localDeletes: [],
    tombstones: [],
  }, CLOCKS);

  assert.deepEqual(result.skipped, ['word']);
  assert.equal(await getOne('vocab', 'word'), undefined, 'still deleted');
});

test('applyPlan writes a record that is new to this device (no clock to race against)', async () => {
  const result = await applyPlan({
    localWrites: [{ entity: 'sessions', id: 'fresh', baseClock: null, record: { id: 'fresh', updatedAt: 1 } }],
    localDeletes: [],
    tombstones: [],
  }, CLOCKS);
  assert.deepEqual(result.written, ['fresh']);
});

test('applyPlan applies deletes and tombstones alongside writes, atomically', async () => {
  await put('sessions', { id: 'gone', updatedAt: 1 });
  const result = await applyPlan({
    localWrites: [{ entity: 'sessions', id: 'kept', baseClock: null, record: { id: 'kept', updatedAt: 1 } }],
    localDeletes: [{ entity: 'sessions', id: 'gone' }],
    tombstones: [{ id: 'session:gone', kind: 'session', targetId: 'gone', deletedAt: 5 }],
  }, CLOCKS);

  assert.deepEqual(result, { written: ['kept'], skipped: [], deleted: ['gone'] });
  assert.equal(await getOne('sessions', 'gone'), undefined);
  assert.equal((await getOne('sessions', 'kept')).id, 'kept');
  assert.deepEqual((await listTombstones()).map((t) => t.id), ['session:gone']);
});

test('a transaction that throws partway leaves nothing behind', async () => {
  await assert.rejects(() => transact(['sessions', 'vocab'], 'readwrite', async (s) => {
    await request(s.sessions.put({ id: 'half', updatedAt: 1 }));
    throw new Error('boom');
  }), /boom/);

  assert.equal(await getOne('sessions', 'half'), undefined, 'the put was rolled back with the transaction');
});
