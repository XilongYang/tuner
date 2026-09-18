import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampContentHashes, saveRecord } from '../../js/app/persist.js';
import { SESSION, VOCAB_ENTRY } from '../../js/model/schema.js';
import { hashBlob, hashString, hashJson } from '../../js/platform/hash.js';
import { blankSentence } from '../../js/model/session.js';

const hash = { hashBlob, hashString, hashJson };

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

test('a stale hash left on a record whose content is gone is cleared', async () => {
  const stamped = await stampContentHashes(SESSION, session({
    sentences: [blankSentence({ id: 's1', text: 'hi', lang: 'en', now: 1, recording: null, recordingHash: 'left-over' })],
  }), { hash });

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

test('saveRecord: stamps then stores, and hands back what was stored', async () => {
  const stored = [];
  const db = { put: async (entity, record) => stored.push([entity, record]) };
  const recording = clip([5]);

  const result = await saveRecord('sessions', session({
    sentences: [blankSentence({ id: 's1', text: 'hi', lang: 'en', now: 1, recording })],
  }), { db, hash });

  assert.equal(stored.length, 1);
  assert.equal(stored[0][0], 'sessions');
  assert.equal(stored[0][1].sentences[0].recordingHash, await hashBlob(recording));
  assert.equal(result, stored[0][1], 'the caller gets the stamped record without a second read');
});
