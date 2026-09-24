import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampContentHashes, saveRecord } from '../../js/app/persist.js';
import { SESSION, VOCAB_ENTRY } from '../../js/model/schema.js';
import { hashBlob, hashString, hashJson, materializeBlob } from '../../js/platform/hash.js';
import { blankSentence } from '../../js/model/session.js';

const hash = { hashBlob, hashString, hashJson, materializeBlob };

const clip = (bytes) => new Blob([new Uint8Array(bytes)], { type: 'audio/wav' });

const session = (over = {}) => ({
  id: 'sess1', name: null, folderId: null, splitMode: 'auto',
  createdAt: 1, updatedAt: 10, metaUpdatedAt: 10,
  inputText: null, inputTextHash: null, sourceAudio: null, sourceAudioHash: null,
  sentences: [], ...over,
});

test('stamps a hash for every content value, of the right kind', async () => {
  const recording = clip([1, 2, 3]);
  const assessment = { pron: 88, words: [] };
  const record = session({
    inputText: 'practice text',
    sentences: [blankSentence({
      id: 's1', text: 'hi', lang: 'en', now: 1, recording, assessment,
    })],
  });

  const stamped = await stampContentHashes(SESSION, record, { hash });

  assert.equal(stamped.inputTextHash, await hashString('practice text'));
  assert.equal(stamped.sentences[0].recordingHash, await hashBlob(recording));
  assert.equal(stamped.sentences[0].assessmentHash, await hashJson(assessment));
});

test('a hash matches one computed from what will actually be stored', async () => {
  // The JSON case: hashing the object some other way would produce a hash that
  // never matches after a round-trip, and sync would re-upload it forever.
  const assessment = { pron: 88, words: [{ word: 'hi', accuracy: 90 }] };
  const stamped = await stampContentHashes(SESSION, session({
    sentences: [blankSentence({ id: 's1', text: 'hi', lang: 'en', now: 1, assessment })],
  }), { hash });

  assert.equal(stamped.sentences[0].assessmentHash, await hashString(JSON.stringify(assessment)));
});

test('an empty slot gets a null hash -- a record never claims content it lacks', async () => {
  const stamped = await stampContentHashes(SESSION, session({
    sentences: [blankSentence({ id: 's1', text: 'hi', lang: 'en', now: 1 })],
  }), { hash });

  assert.equal(stamped.inputTextHash, null);
  assert.equal(stamped.sourceAudioHash, null);
  assert.equal(stamped.sentences[0].recordingHash, null);
});

test('unchanged content keeps its hash instead of being re-read', async () => {
  const recording = clip([1, 2, 3]);
  const before = await stampContentHashes(SESSION, session({
    sentences: [blankSentence({ id: 's1', text: 'hi', lang: 'en', now: 1, recording })],
  }), { hash });

  let reads = 0;
  const countingHash = { ...hash, hashBlob: async (b) => { reads++; return hashBlob(b); } };

  // The same Blob instance: its bytes cannot have changed.
  const after = await stampContentHashes(SESSION, { ...before, updatedAt: 20 }, { hash: countingHash, previous: before });

  assert.equal(reads, 0);
  assert.equal(after.sentences[0].recordingHash, before.sentences[0].recordingHash);
});

test('replaced content is re-hashed even when the previous record is given', async () => {
  const first = clip([1]);
  const before = await stampContentHashes(SESSION, session({
    sentences: [blankSentence({ id: 's1', text: 'hi', lang: 'en', now: 1, recording: first })],
  }), { hash });

  const second = clip([2]);
  const after = await stampContentHashes(SESSION, {
    ...before,
    sentences: [{ ...before.sentences[0], recording: second }],
  }, { hash, previous: before });

  assert.equal(after.sentences[0].recordingHash, await hashBlob(second));
  assert.notEqual(after.sentences[0].recordingHash, before.sentences[0].recordingHash);
});

test('identical bytes in a different object are re-hashed, which merely costs a read', async () => {
  const before = await stampContentHashes(SESSION, session({
    sentences: [blankSentence({ id: 's1', text: 'hi', lang: 'en', now: 1, recording: clip([7]) })],
  }), { hash });

  const after = await stampContentHashes(SESSION, {
    ...before,
    sentences: [{ ...before.sentences[0], recording: clip([7]) }],
  }, { hash, previous: before });

  assert.equal(after.sentences[0].recordingHash, before.sentences[0].recordingHash, 'same bytes, same hash');
});

test('stamps vocab occurrence audio too, nested two levels down', async () => {
  const audio = clip([9]);
  const stamped = await stampContentHashes(VOCAB_ENTRY, {
    id: 'word', text: 'word', lang: 'en', audioPathKey: 'k1', createdAt: 1, updatedAt: 1,
    sources: [{ occurrenceId: 'o1', sessionId: null, sentenceId: null, sentenceTextSnapshot: null, addedAt: 1, audio }],
  }, { hash });

  assert.equal(stamped.sources[0].audioHash, await hashBlob(audio));
});

test('does not mutate the record it was given, and keeps every other field', async () => {
  const record = session({ name: 'Lesson 3', inputText: 'text' });
  const snapshot = JSON.stringify({ ...record, inputText: record.inputText });
  const stamped = await stampContentHashes(SESSION, record, { hash });

  assert.equal(record.inputTextHash, null, 'the original is untouched');
  assert.equal(JSON.stringify({ ...record, inputText: record.inputText }), snapshot);
  assert.equal(stamped.name, 'Lesson 3');
  assert.equal(stamped.createdAt, 1);
});

/** A database that records what it was asked to store, and what it already holds. */
function fakeDb(held = new Map()) {
  const writes = [];
  return {
    writes,
    held,
    storedContentHashes: async (paths) => new Map(paths.filter((p) => held.has(p)).map((p) => [p, held.get(p)])),
    putRecord: async (entity, record, entries, tombstones = []) => {
      for (const entry of entries) held.set(entry.path, entry.hash);
      writes.push({ entity, record, entries, tombstones });
    },
  };
}

test('saveRecord: stamps then stores, and hands back what was stored', async () => {
  const db = fakeDb();
  const recording = clip([5]);

  const result = await saveRecord('sessions', session({
    sentences: [blankSentence({ id: 's1', text: 'hi', lang: 'en', now: 1, recording })],
  }), { db, hash });

  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].entity, 'sessions');
  assert.equal(db.writes[0].record.sentences[0].recordingHash, await hashBlob(recording));
  assert.equal(result, db.writes[0].record, 'the caller gets the stamped record without a second read');
});

test('saveRecord: content the store already holds under that hash is not written again', async () => {
  // The rule the storage layout exists for: a record is rewritten on every
  // edit, and its audio is not rewritten with it.
  const db = fakeDb();
  const recording = clip([5, 6, 7]);
  const record = session({ sentences: [blankSentence({ id: 's1', text: 'hi', lang: 'en', now: 1, recording })] });

  const first = await saveRecord('sessions', record, { db, hash });
  const second = await saveRecord('sessions', { ...first, name: 'renamed' }, { db, hash, previous: first });
  const third = await saveRecord('sessions', { ...second, name: 'again' }, { db, hash, previous: second });

  assert.equal(db.writes[0].entries.length, 1, 'the bytes go in once');
  assert.deepEqual(db.writes[1].entries, [], 'and not again');
  assert.deepEqual(db.writes[2].entries, []);
  assert.equal(third.sentences[0].recordingHash, await hashBlob(recording));
});

test('saveRecord: replacing the content writes the new bytes, under the same path', async () => {
  const db = fakeDb();
  const first = await saveRecord('sessions', session({
    sentences: [blankSentence({ id: 's1', text: 'hi', lang: 'en', now: 1, recording: clip([1]) })],
  }), { db, hash });

  const retaken = clip([9, 9]);
  const second = await saveRecord('sessions', {
    ...first,
    sentences: [{ ...first.sentences[0], recording: retaken, recordingHash: null }],
  }, { db, hash, previous: first });

  assert.deepEqual(db.writes[1].entries.map((e) => e.path), ['recordings/sess1/s1.wav']);
  assert.equal(db.writes[1].entries[0].hash, await hashBlob(retaken));
  assert.equal(second.sentences[0].recordingHash, await hashBlob(retaken));
});

test('saveRecord: the stored record carries no bytes of its own', async () => {
  const db = fakeDb();
  await saveRecord('sessions', session({
    inputText: 'hello',
    sentences: [blankSentence({ id: 's1', text: 'hi', lang: 'en', now: 1, recording: clip([2]) })],
  }), { db, hash });

  // saveRecord hands the record to the database whole; the database is what
  // strips it (see db/entities.js), so what matters here is that every byte it
  // sent went as a content entry.
  assert.deepEqual(db.writes[0].entries.map((e) => e.path).sort(),
    ['inputtext/sess1.txt', 'recordings/sess1/s1.wav']);
});

test('stampContentHashes: a claim whose bytes are missing is kept, not nulled', async () => {
  // This replaces a test that asserted the opposite. It was right while a
  // record carried its own bytes, because a hash with no value beside it could
  // only be a leftover. Now that bytes live in the content store and a record
  // is hydrated on the way out, a hash with no value means the bytes are not
  // in hand -- and nulling it would drop the claim on every device at the next
  // sync, after which the container's copy, possibly the last readable one,
  // would be swept as an orphan.
  const record = session({
    sentences: [blankSentence({
      id: 's1', text: 'hi', lang: 'en', now: 1,
      recording: null, recordingHash: 'a-hash-whose-bytes-are-gone',
    })],
  });

  const stamped = await stampContentHashes(SESSION, record, { hash });

  assert.equal(stamped.sentences[0].recordingHash, 'a-hash-whose-bytes-are-gone');
});

test('stampContentHashes: a caller clearing content clears the claim with it', async () => {
  // The other half of the same rule: a retake or a delete sets both to null,
  // and stamping must not put the hash back.
  const record = session({
    sentences: [blankSentence({ id: 's1', text: 'hi', lang: 'en', now: 1, recording: null, recordingHash: null })],
  });

  const stamped = await stampContentHashes(SESSION, record, { hash });

  assert.equal(stamped.sentences[0].recordingHash, null);
});

test('saveRecord: a claim with no bytes writes no content entry', async () => {
  const db = fakeDb();

  await saveRecord('sessions', session({
    sentences: [blankSentence({ id: 's1', text: 'hi', lang: 'en', now: 1, recording: null, recordingHash: 'gone' })],
  }), { db, hash });

  assert.deepEqual(db.writes[0].entries, [], 'nothing to store, and nothing claimed away');
  assert.equal(db.writes[0].record.sentences[0].recordingHash, 'gone');
});

test('saveRecord: a child this save dropped is tombstoned by this save', async () => {
  // A split replaces one sentence with two. The replaced sentence has to be
  // tombstoned or a device that has not seen the split brings it back -- and
  // the tombstone has to land in the same transaction as the record that no
  // longer lists it. Written separately, as it was, there is a moment where
  // one of the two has happened: tombstones for sentences the stored session
  // still contains, which the next sync applies, deleting a sentence whose
  // replacement was never saved.
  const db = fakeDb();
  const before = await saveRecord('sessions', session({
    sentences: [
      blankSentence({ id: 's1', text: 'one', lang: 'en', now: 1 }),
      blankSentence({ id: 's2', text: 'two', lang: 'en', now: 1 }),
    ],
  }), { db, hash });

  await saveRecord('sessions', { ...before, sentences: [before.sentences[0]] },
    { db, hash, previous: before, now: 500 });

  assert.deepEqual(db.writes[0].tombstones, [], 'a first save has nothing to compare against');
  assert.deepEqual(db.writes[1].tombstones,
    [{ id: 'sentence:s2', kind: 'sentence', targetId: 's2', deletedAt: 500 }]);
});

test('saveRecord: a previous belonging to another record tombstones nothing', async () => {
  // `previous` is the last thing this saver wrote, and after a session switch
  // that is a different session entirely. Diffing across the two would
  // tombstone every sentence of the one just left.
  const db = fakeDb();
  const other = await saveRecord('sessions', session({
    id: 'other', sentences: [blankSentence({ id: 'x1', text: 'x', lang: 'en', now: 1 })],
  }), { db, hash });

  await saveRecord('sessions', session({
    sentences: [blankSentence({ id: 's1', text: 'one', lang: 'en', now: 1 })],
  }), { db, hash, previous: other, now: 500 });

  assert.deepEqual(db.writes[1].tombstones, []);
});

test('saveRecord: an occurrence that went away is not tombstoned', async () => {
  // Occurrences merge as a union, so a device that has not seen the removal
  // legitimately still holds it; a tombstone would delete it there too. Only
  // last-write-wins children carry deletions.
  const db = fakeDb();
  const entry = {
    id: 'w1', text: 'word', lang: 'ja', hidden: false, audioPathKey: 'k1',
    createdAt: 1, updatedAt: 1,
    sources: [
      { occurrenceId: 'o1', sessionId: 'sess1', sentenceId: 's1', sentenceTextSnapshot: null, addedAt: 1, audio: null, audioHash: null },
      { occurrenceId: 'o2', sessionId: 'sess1', sentenceId: 's2', sentenceTextSnapshot: null, addedAt: 1, audio: null, audioHash: null },
    ],
  };
  const first = await saveRecord('vocab', entry, { db, hash });
  await saveRecord('vocab', { ...first, sources: [first.sources[0]] }, { db, hash, previous: first, now: 500 });

  assert.deepEqual(db.writes[1].tombstones, []);
});
