import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickNewer, mergeSentences, mergeSession, mergeFolder, mergeById, mergeTombstones, survivesTombstone,
} from '../js/sync/merge.js';

test('pickNewer: picks b when strictly newer, a on tie or when a is newer', () => {
  assert.equal(pickNewer(1, 2), 'b');
  assert.equal(pickNewer(2, 1), 'a');
  assert.equal(pickNewer(5, 5), 'a');
  assert.equal(pickNewer(0, 0), 'a');
  assert.equal(pickNewer(undefined, 1), 'b');
  assert.equal(pickNewer(1, undefined), 'a');
});

test('mergeSentences: a remote-only id with no preceding remote sibling lands at the front', () => {
  // 'b' is remote's very first (and only) sentence, with nothing before it in
  // remote's own order -- there's no anchor to place it relative to, so it
  // goes to the front rather than the tail. This is also what makes the
  // regression test below (a remote Split of the session's first sentence)
  // come out right.
  const local = [{ id: 'a', updatedAt: 1 }];
  const remote = [{ id: 'b', updatedAt: 1 }];
  const merged = mergeSentences(local, remote);
  assert.deepEqual(merged.map((s) => s.id), ['b', 'a']);
  assert.equal(merged[0].__from, 'remote');
  assert.equal(merged[1].__from, 'local');
});

test('mergeSentences: a remote-only id is inserted right after its nearest placed remote sibling, not appended at the end', () => {
  // remote's order is [a, new, c] -- 'new' sits between 'a' and 'c'. Local
  // only knows [a, c] (hasn't seen 'new' yet). 'new' must land between them,
  // not at the tail after 'c'.
  const local = [{ id: 'a', updatedAt: 1 }, { id: 'c', updatedAt: 1 }];
  const remote = [{ id: 'a', updatedAt: 1 }, { id: 'new', updatedAt: 5 }, { id: 'c', updatedAt: 1 }];
  const merged = mergeSentences(local, remote);
  assert.deepEqual(merged.map((s) => s.id), ['a', 'new', 'c']);
});

test('mergeSentences: regression -- splitting the FIRST sentence on another device keeps the result at the front after sync, not at the tail', () => {
  // Device B split the session's first sentence ('old-first') into two new
  // ones and tombstoned 'old-first' (split-actions.js's real behavior).
  // This device (local) hasn't made that change: it still has the original
  // three sentences, 'old-first' among them.
  const local = [
    { id: 'old-first', updatedAt: 1 },
    { id: 'second', updatedAt: 1 },
    { id: 'third', updatedAt: 1 },
  ];
  const remote = [
    { id: 'first-half', updatedAt: 5 },
    { id: 'second-half', updatedAt: 5 },
    { id: 'second', updatedAt: 1 },
    { id: 'third', updatedAt: 1 },
  ];
  const tombstoneById = new Map([['sentence:old-first', { deletedAt: 5 }]]);
  const merged = mergeSentences(local, remote, tombstoneById);
  assert.deepEqual(merged.map((s) => s.id), ['first-half', 'second-half', 'second', 'third']);
});

test('mergeSentences: shared id resolves via last-write-wins on updatedAt', () => {
  const local = [{ id: 'a', text: 'local text', updatedAt: 1 }];
  const remote = [{ id: 'a', text: 'remote text', updatedAt: 2 }];
  const merged = mergeSentences(local, remote);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, 'remote text');
  assert.equal(merged[0].__from, 'remote');
});

test('mergeSentences: a tombstoned id is dropped from the union unless re-touched after the delete', () => {
  const local = [{ id: 'a', updatedAt: 1 }];
  const remote = [{ id: 'a', updatedAt: 1 }, { id: 'b', updatedAt: 5 }];
  const tombstoneById = new Map([
    ['sentence:a', { deletedAt: 10 }], // deleted after both sides' updatedAt -> gone
    ['sentence:b', { deletedAt: 1 }],  // deleted before b's updatedAt -> b survives (edited after delete)
  ]);
  const merged = mergeSentences(local, remote, tombstoneById);
  assert.deepEqual(merged.map((s) => s.id), ['b']);
});

test('mergeSentences: without tombstoneById, every id survives regardless', () => {
  const local = [{ id: 'a', updatedAt: 1 }];
  const merged = mergeSentences(local, [], undefined);
  assert.deepEqual(merged.map((s) => s.id), ['a']);
});

test('mergeSession: metadata resolves via metaUpdatedAt, not the general updatedAt', () => {
  const local = {
    id: 's1', name: 'Local name', updatedAt: 100, metaUpdatedAt: 1, createdAt: 0, sentences: [],
  };
  const remote = {
    id: 's1', name: 'Remote name', updatedAt: 1, metaUpdatedAt: 200, createdAt: 0, sentences: [],
  };
  const merged = mergeSession(local, remote);
  // remote's metaUpdatedAt (200) beats local's (1), even though local's plain updatedAt is higher
  assert.equal(merged.name, 'Remote name');
  assert.equal(merged.__metaFrom, 'remote');
  // updatedAt/createdAt still fold via max/min across both sides
  assert.equal(merged.updatedAt, 100);
});

test('mergeSession: one side absent just falls back to the other', () => {
  const remote = {
    id: 's1', name: 'Only remote', updatedAt: 5, metaUpdatedAt: 5, createdAt: 5, sentences: [],
  };
  const merged = mergeSession(null, remote);
  assert.equal(merged.name, 'Only remote');
  assert.equal(merged.__metaFrom, 'remote');
});

test('mergeFolder: plain LWW on updatedAt, with either side possibly absent', () => {
  const a = { id: 'f1', name: 'A', updatedAt: 1 };
  const b = { id: 'f1', name: 'B', updatedAt: 2 };
  assert.equal(mergeFolder(a, b).name, 'B');
  assert.equal(mergeFolder(b, a).name, 'B');
  assert.deepEqual(mergeFolder(null, b), { ...b });
  assert.deepEqual(mergeFolder(a, null), { ...a });
});

test('mergeById: unions two lists by id, merging shared ids and appending remote-only ones', () => {
  const localList = [{ id: '1', v: 'local' }, { id: '2', v: 'local' }];
  const remoteList = [{ id: '2', v: 'remote' }, { id: '3', v: 'remote' }];
  const merged = mergeById(localList, remoteList, (l, r) => (r ? { id: (l || r).id, v: r ? 'merged' : l.v } : l));
  assert.deepEqual(merged.map((m) => m.id), ['1', '2', '3']);
  assert.equal(merged[0].v, 'local');
  assert.equal(merged[1].v, 'merged');
});

test('mergeTombstones: keeps the newer deletedAt per id across both lists', () => {
  const localList = [{ id: 'session:1', deletedAt: 5 }];
  const remoteList = [{ id: 'session:1', deletedAt: 10 }, { id: 'session:2', deletedAt: 3 }];
  const merged = mergeTombstones(localList, remoteList);
  const byId = new Map(merged.map((t) => [t.id, t]));
  assert.equal(byId.get('session:1').deletedAt, 10);
  assert.equal(byId.get('session:2').deletedAt, 3);
});

test('survivesTombstone: no tombstone means it survives; an update after deletion "un-deletes" it', () => {
  const tombstoneById = new Map([['session:1', { deletedAt: 10 }]]);
  assert.equal(survivesTombstone('session', { id: '1', updatedAt: 5 }, tombstoneById), false);
  assert.equal(survivesTombstone('session', { id: '1', updatedAt: 20 }, tombstoneById), true);
  assert.equal(survivesTombstone('session', { id: '2', updatedAt: 0 }, tombstoneById), true);
});
