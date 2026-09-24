import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getOne, listAll, listTombstones, snapshot, put, putMany, putRecord,
  remove, removeRecord, clearAll, applyPlan, sweepContent,
} from '../../js/db/entities.js';
import { listContentPaths } from '../../js/db/content.js';
import { transact, ALL_STORES, request, dbError } from '../../js/db/open.js';

const CLOCKS = { sessions: 'updatedAt', vocab: 'updatedAt' };

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

test('a record is stored without its content, and comes back with it', async () => {
  const recording = new Blob([new Uint8Array([3, 4])], { type: 'audio/wav' });
  const record = {
    id: 's1', updatedAt: 5,
    sentences: [{ id: 'x', text: 'hi', recording, recordingHash: 'h3' }],
  };

  await putRecord('sessions', record, [
    { path: 'recordings/s1/x.wav', kind: 'recording', hash: 'h3', value: recording },
  ]);

  const raw = await transact([ALL_STORES[0]], 'readonly', (s) => request(s.sessions.get('s1')));
  assert.equal(raw.sentences[0].recording, null, 'the record holds no bytes');
  assert.equal(raw.sentences[0].recordingHash, 'h3', 'only the claim');

  const whole = await getOne('sessions', 's1');
  assert.deepEqual([...new Uint8Array(await whole.sentences[0].recording.arrayBuffer())], [3, 4]);
});

test('a hash whose content is missing comes back as a claim with nothing behind it', async () => {
  // What a clip whose bytes were lost looks like: the sentence still says it
  // has one, so a sync can fetch it back, and the UI can say it is unplayable
  // rather than pretending it never existed.
  await put('sessions', { id: 's1', updatedAt: 1, sentences: [{ id: 'x', text: 'hi', recordingHash: 'gone' }] });

  const whole = await getOne('sessions', 's1');
  assert.equal(whole.sentences[0].recording, null);
  assert.equal(whole.sentences[0].recordingHash, 'gone');
});

test('deleting a record takes its content with it', async () => {
  const value = new Blob([new Uint8Array([1])]);
  await putRecord('sessions', { id: 's1', updatedAt: 1, sentences: [{ id: 'x', recordingHash: 'h' }] },
    [{ path: 'recordings/s1/x.wav', kind: 'recording', hash: 'h', value }]);

  await remove('sessions', 's1');

  assert.deepEqual(await listContentPaths(), []);
});

test('sweepContent removes what no record references any more', async () => {
  const value = new Blob([new Uint8Array([1])]);
  await putRecord('sessions', { id: 's1', updatedAt: 1, sentences: [{ id: 'kept', recordingHash: 'h' }] }, [
    { path: 'recordings/s1/kept.wav', kind: 'recording', hash: 'h', value },
    // What a split or a merge leaves behind: bytes whose sentence is gone.
    { path: 'recordings/s1/orphan.wav', kind: 'recording', hash: 'h2', value },
  ]);

  const swept = await sweepContent();

  assert.deepEqual(swept, ['recordings/s1/orphan.wav']);
  assert.deepEqual(await listContentPaths(), ['recordings/s1/kept.wav']);
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

test('putRecord lands a record and the deletions it carries in one transaction', async () => {
  // Sentences have no record of their own, so a split's replaced sentence is
  // only ever a tombstone. It rides with the save that dropped it (see
  // app/persist.js): the two cannot be observed apart, which is the whole
  // reason this parameter exists rather than a call of its own.
  await putRecord('sessions', { id: 's1', updatedAt: 2, sentences: [{ id: 'kept' }] }, [], [
    { id: 'sentence:gone', kind: 'sentence', targetId: 'gone', deletedAt: 100 },
  ]);

  assert.deepEqual((await getOne('sessions', 's1')).sentences.map((x) => x.id), ['kept']);
  assert.deepEqual((await listTombstones()).map((t) => t.id), ['sentence:gone']);
});

test('clearAll wipes every collection and tombstones every record first', async () => {
  await put('sessions', { id: 's1', updatedAt: 1 });
  await put('vocab', { id: 'v1', updatedAt: 1 });

  await clearAll(777);

  assert.deepEqual(await listAll('sessions'), []);
  assert.deepEqual(await listAll('vocab'), []);
  assert.deepEqual((await listTombstones()).map((t) => t.id).sort(), ['session:s1', 'vocab:v1']);
});

test('snapshot reads every collection in one consistent view', async () => {
  await put('sessions', { id: 's1', updatedAt: 1 });
  await put('vocab', { id: 'v1', updatedAt: 1 });
  const snap = await snapshot();
  assert.deepEqual(Object.keys(snap).sort(), ['sessions', 'tombstones', 'vocab']);
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

test('dbError: a failure with no error object still arrives as one', () => {
  // WebKit aborts a transaction with tx.error === null. Rejecting with that
  // null is how a failed save becomes a silent one: the handler reads
  // `.message` of null and throws inside its own catch.
  const invented = dbError(null, 'The write');

  assert.ok(invented instanceof Error);
  assert.match(invented.message, /The write failed, and the browser gave no reason/);
  assert.equal(invented.name, 'UnknownError');
});

test('dbError: a real failure is passed through untouched', () => {
  const real = Object.assign(new Error('Error preparing Blob/File data to be stored in object store'), { name: 'UnknownError' });
  assert.equal(dbError(real, 'The write'), real);
});

test('a record and its content land together, or neither does', async () => {
  // They are one transaction because the hash and the bytes it names have to
  // become true at the same moment. Forced here by a record the engine refuses
  // to serialize: the content write has already gone in when it fails, so
  // rolling back is the only way the store can come out of it consistent.
  const value = new Blob([new Uint8Array([1, 2])]);
  const refused = {
    id: 's1', updatedAt: 1,
    unserializable: () => {}, // structured clone cannot take a function
    sentences: [{ id: 'x', recordingHash: 'h' }],
  };

  await assert.rejects(() => putRecord('sessions', refused, [
    { path: 'recordings/s1/x.wav', kind: 'recording', hash: 'h', value },
  ]));

  assert.equal(await getOne('sessions', 's1'), undefined, 'no record');
  assert.deepEqual(await listContentPaths(), [], 'and no bytes left behind by the attempt');
});

test('a deletion and its tombstone land together, or neither does', async () => {
  await put('sessions', { id: 's1', updatedAt: 1 });

  // Same shape of argument, on the pair whose split once resurrected deleted
  // records: the record goes and the tombstone that carries the deletion is
  // recorded in the same transaction.
  await remove('sessions', 's1');

  assert.equal(await getOne('sessions', 's1'), undefined);
  assert.deepEqual((await listTombstones()).map((t) => t.targetId), ['s1']);
});
