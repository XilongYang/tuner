import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tombstoneId, mergeTombstones, survives, mergeEntity, mergeCollection,
} from '../../js/model/merge.js';
import { SESSION, SENTENCE, VOCAB_ENTRY, OCCURRENCE, entity, f } from '../../js/model/schema.js';

// A deliberately plain entity -- an id and flat fields, no content, no children
// -- so the generic merge can be exercised on its own. Defined here rather than
// borrowed from a real one: a test that needs "the simplest possible entity"
// should say so, not depend on some production entity happening to stay simple.
const PLAIN = entity('plain', {
  id: f.id(),
  name: f.plain({ default: null }),
  parentId: f.plain({ default: null }),
  createdAt: f.plain({ default: 0 }),
  updatedAt: f.plain({ default: 0 }),
});

const tombstones = (...entries) => new Map(entries.map(([kind, id, deletedAt]) => [tombstoneId(kind, id), { id: tombstoneId(kind, id), kind, targetId: id, deletedAt }]));

test('mergeTombstones: unions both sides and keeps the earliest record of each deletion', () => {
  const merged = mergeTombstones(
    [{ id: 'session:a', deletedAt: 500 }],
    [{ id: 'session:a', deletedAt: 900 }, { id: 'vocab:b', deletedAt: 100 }],
  );
  assert.deepEqual(merged, [
    { id: 'session:a', deletedAt: 500 },
    { id: 'vocab:b', deletedAt: 100 },
  ]);
});

test('survives: a tombstone removes a record that has not changed since', () => {
  assert.equal(survives(SESSION, { id: 'a', updatedAt: 400 }, 'session', tombstones(['session', 'a', 500])), false);
});

test('survives: an edit after the deletion un-deletes it', () => {
  assert.equal(survives(SESSION, { id: 'a', updatedAt: 600 }, 'session', tombstones(['session', 'a', 500])), true);
});

test('survives: an edit at exactly the deletion time loses -- the delete is the later intent', () => {
  assert.equal(survives(SESSION, { id: 'a', updatedAt: 500 }, 'session', tombstones(['session', 'a', 500])), false);
});

test('survives: no tombstone means it lives', () => {
  assert.equal(survives(SESSION, { id: 'a', updatedAt: 1 }, 'session', new Map()), true);
});

test('mergeEntity: one side missing returns the present side, normalised', () => {
  const merged = mergeEntity(PLAIN, { id: 3, name: 'Only local', updatedAt: 9 }, null);
  assert.deepEqual(merged, { id: 3, name: 'Only local', parentId: null, createdAt: 0, updatedAt: 9 });
});

test('mergeEntity: refuses two nulls rather than inventing a record', () => {
  assert.throws(() => mergeEntity(PLAIN, null, null), /both sides null/);
});

test('mergeEntity: the newer meta clock supplies the record\'s own fields as one group', () => {
  const local = {
    id: 's1', name: 'local name', sortKey: 'a0', splitMode: 'auto',
    createdAt: 10, updatedAt: 900, metaUpdatedAt: 100,
  };
  const remote = {
    id: 's1', name: 'remote name', sortKey: null, splitMode: 'audio',
    createdAt: 10, updatedAt: 200, metaUpdatedAt: 300,
  };
  const merged = mergeEntity(SESSION, local, remote);
  // Remote's meta clock is newer, so ALL of its own fields win together --
  // never a mix of local's name with remote's position.
  assert.equal(merged.name, 'remote name');
  assert.equal(merged.sortKey, null);
  assert.equal(merged.splitMode, 'audio');
});

test('mergeEntity: a local sentence edit does not let the session outrank a remote rename', () => {
  // The reason SESSION has a separate metaClock: editing a sentence bumps the
  // session's updatedAt, which must not count as "this device renamed it".
  const local = { id: 's1', name: 'old name', updatedAt: 999, metaUpdatedAt: 100, createdAt: 1 };
  const remote = { id: 's1', name: 'renamed elsewhere', updatedAt: 200, metaUpdatedAt: 500, createdAt: 1 };
  assert.equal(mergeEntity(SESSION, local, remote).name, 'renamed elsewhere');
});

test('mergeEntity: clocks take the max, createdAt takes the min', () => {
  const merged = mergeEntity(SESSION,
    { id: 's', createdAt: 50, updatedAt: 900, metaUpdatedAt: 100 },
    { id: 's', createdAt: 10, updatedAt: 200, metaUpdatedAt: 700 });
  assert.equal(merged.createdAt, 10);
  assert.equal(merged.updatedAt, 900);
  assert.equal(merged.metaUpdatedAt, 700);
});

test('mergeEntity: content yields a hash and an unresolved value, never bytes', () => {
  const merged = mergeEntity(SENTENCE,
    { id: 'a', updatedAt: 100, recording: 'LOCAL BYTES', recordingHash: 'lh' },
    { id: 'a', updatedAt: 200, recordingHash: 'rh' });
  assert.equal(merged.recordingHash, 'rh', 'newer side supplies the hash');
  assert.equal(merged.recording, null, 'bytes are the planner\'s problem, not the merger\'s');
});

test('mergeEntity: no internal marker fields leak into the merged record', () => {
  const merged = mergeEntity(SENTENCE, { id: 'a', updatedAt: 1 }, { id: 'a', updatedAt: 2 });
  assert.deepEqual(Object.keys(merged).filter((k) => k.startsWith('__')), []);
});

test('mergeEntity: lww children match by id and keep the newer of each', () => {
  const local = {
    id: 's', updatedAt: 10, metaUpdatedAt: 10,
    sentences: [
      { id: 'a', text: 'local a', updatedAt: 100 },
      { id: 'b', text: 'local b', updatedAt: 500 },
    ],
  };
  const remote = {
    id: 's', updatedAt: 10, metaUpdatedAt: 10,
    sentences: [
      { id: 'a', text: 'remote a', updatedAt: 300 },
      { id: 'b', text: 'remote b', updatedAt: 200 },
    ],
  };
  const merged = mergeEntity(SESSION, local, remote);
  assert.deepEqual(merged.sentences.map((s) => s.text), ['remote a', 'local b']);
});

test('mergeEntity: a sentence only one side has is kept', () => {
  const merged = mergeEntity(SESSION,
    { id: 's', sentences: [{ id: 'a', updatedAt: 1 }] },
    { id: 's', sentences: [{ id: 'b', updatedAt: 1 }] });
  assert.deepEqual(merged.sentences.map((s) => s.id), ['a', 'b']);
});

test('mergeEntity: a tombstoned sentence is dropped, so split/merge replacements do not come back', () => {
  const merged = mergeEntity(SESSION,
    { id: 's', sentences: [{ id: 'new1', updatedAt: 900 }, { id: 'new2', updatedAt: 900 }] },
    { id: 's', sentences: [{ id: 'old', updatedAt: 100 }] },
    { tombstones: tombstones(['sentence', 'old', 800]), childKind: 'sentence' });
  assert.deepEqual(merged.sentences.map((s) => s.id), ['new1', 'new2']);
});

test('mergeEntity: union children keep BOTH devices\' additions', () => {
  // The rule that matters most for vocab: two devices each recorded a
  // different occurrence of the same word. Last-write-wins on the array would
  // throw one away.
  const local = {
    id: 'word', text: 'word', audioPathKey: 'k', updatedAt: 100,
    sources: [{ occurrenceId: 'occ-a', addedAt: 100, sentenceTextSnapshot: 'from A' }],
  };
  const remote = {
    id: 'word', text: 'word', audioPathKey: 'k', updatedAt: 200,
    sources: [{ occurrenceId: 'occ-b', addedAt: 200, sentenceTextSnapshot: 'from B' }],
  };
  const merged = mergeEntity(VOCAB_ENTRY, local, remote);
  assert.deepEqual(merged.sources.map((s) => s.occurrenceId), ['occ-a', 'occ-b']);
});

test('mergeEntity: union children are order-independent, so converged devices produce identical output', () => {
  const a = { occurrenceId: 'x', addedAt: 100 };
  const b = { occurrenceId: 'y', addedAt: 200 };
  const c = { occurrenceId: 'z', addedAt: 150 };
  const one = mergeEntity(VOCAB_ENTRY, { id: 'w', audioPathKey: 'k', sources: [a, b] }, { id: 'w', audioPathKey: 'k', sources: [c] });
  const two = mergeEntity(VOCAB_ENTRY, { id: 'w', audioPathKey: 'k', sources: [c, b] }, { id: 'w', audioPathKey: 'k', sources: [a] });
  assert.equal(JSON.stringify(one), JSON.stringify(two));
});

test('mergeEntity: an occurrence both sides know about appears exactly once', () => {
  const shared = { occurrenceId: 'occ', addedAt: 100, audioHash: 'ah' };
  const merged = mergeEntity(VOCAB_ENTRY,
    { id: 'w', audioPathKey: 'k', sources: [shared] },
    { id: 'w', audioPathKey: 'k', sources: [{ ...shared }] });
  assert.equal(merged.sources.length, 1);
  assert.equal(merged.sources[0].audioHash, 'ah');
});

test('mergeCollection: reports survivors and casualties separately', () => {
  const { survivors, deleted } = mergeCollection(
    SESSION,
    [{ id: 'keep', updatedAt: 100 }, { id: 'drop', updatedAt: 100 }],
    [{ id: 'remote-only', updatedAt: 50 }],
    { tombstones: tombstones(['session', 'drop', 200]), kind: 'session', childKind: 'sentence' },
  );
  assert.deepEqual(survivors.map((s) => s.id), ['keep', 'remote-only']);
  assert.deepEqual(deleted, ['drop']);
});

test('mergeCollection: with no tombstones nothing is deleted', () => {
  const { survivors, deleted } = mergeCollection(SENTENCE, [{ id: 'a', updatedAt: 1 }], [{ id: 'b', updatedAt: 1 }], {});
  assert.deepEqual(survivors.map((s) => s.id), ['a', 'b']);
  assert.deepEqual(deleted, []);
});

// ---- two devices have to reach the same answer ----

const occurrence = (over = {}) => ({
  occurrenceId: 'o1', sessionId: 's1', sentenceId: 'x',
  sentenceTextSnapshot: 'OLD', addedAt: 1000, audio: null, audioHash: 'hA', ...over,
});

test('mergeEntity: an occurrence is merged by when it was recorded', () => {
  // It has no `updatedAt`, so without a clock of its own every field compared 0
  // against 0 and the copy that happened to be passed first won -- which for a
  // re-picked word meant each device kept its own snapshot and audio hash, and
  // the two never converged.
  const older = occurrence();
  const newer = occurrence({ sentenceTextSnapshot: 'NEW', addedAt: 5000, audioHash: 'hB' });

  for (const [local, remote] of [[older, newer], [newer, older]]) {
    const merged = mergeEntity(OCCURRENCE, local, remote);
    assert.equal(merged.sentenceTextSnapshot, 'NEW');
    assert.equal(merged.audioHash, 'hB');
  }
});

test('mergeEntity: a tie is broken the same way on both devices', () => {
  // Two edits in the same millisecond. "Whichever was passed as local" means
  // each device keeps its own value and republishes it, and every round from
  // then on sees the manifest as changed.
  const one = { id: 'v', name: 'Alpha', createdAt: 1, updatedAt: 5, metaUpdatedAt: 5, sentences: [] };
  const other = { ...one, name: 'Beta' };

  assert.equal(mergeEntity(SESSION, one, other).name, mergeEntity(SESSION, other, one).name);
});

test('mergeEntity: a real difference in clocks still decides', () => {
  const one = { id: 'v', name: 'Alpha', createdAt: 1, updatedAt: 5, metaUpdatedAt: 5, sentences: [] };
  const newer = { ...one, name: 'Beta', metaUpdatedAt: 9 };

  assert.equal(mergeEntity(SESSION, one, newer).name, 'Beta');
  assert.equal(mergeEntity(SESSION, newer, one).name, 'Beta');
});
