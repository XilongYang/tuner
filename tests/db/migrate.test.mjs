// The one-time move of version 1's inline content into the content store,
// driven against records written the way version 1 wrote them.
import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { migrateInlineContent, assignSortKeys } from '../../js/db/migrate.js';
import { getOne, snapshot } from '../../js/db/entities.js';
import { listContentPaths, readOne } from '../../js/db/content.js';
import { SESSIONS, VOCAB, ALL_STORES, transact, request } from '../../js/db/open.js';
import { materializeBlob } from '../../js/platform/hash.js';

const hash = { materializeBlob };
const clip = (bytes) => new Blob([new Uint8Array(bytes)], { type: 'audio/wav' });

/** A write of the kind version 1 made: the bytes live inside the record. */
const storeInline = (store, record) => transact([store], 'readwrite', (s) => request(s[store].put(record)));

/** The record exactly as it is stored, without the content store filled in over it. */
const raw = (store, id) => transact([store], 'readonly', (s) => request(s[store].get(id)));

const oldSession = (over = {}) => ({
  id: 'sess1', name: null, folderId: null, splitMode: 'auto',
  createdAt: 1, updatedAt: 10, metaUpdatedAt: 10,
  inputText: 'hello', inputTextHash: 'h-text',
  sourceAudio: null, sourceAudioHash: null,
  sentences: [{
    id: 's1', text: 'hi', lang: 'en', hidden: false, updatedAt: 10,
    words: null, referenceSource: 'tts',
    sourceOffsetMs: null, sourceDurationMs: null,
    recording: clip([1, 2]), recordingHash: 'h-rec',
    reference: clip([3, 4, 5]), referenceHash: 'h-ref',
    assessment: null, assessmentHash: null,
  }],
  ...over,
});

beforeEach(async () => {
  await transact(ALL_STORES, 'readwrite', async (s) => {
    for (const name of ALL_STORES) await request(s[name].clear());
  });
});

test('moves every inline value into the content store, under its blob path', async () => {
  await storeInline(SESSIONS, oldSession());

  const result = await migrateInlineContent({ hash });

  assert.equal(result.records, 1);
  assert.deepEqual(result.moved.sort(), [
    'inputtext/sess1.txt', 'recordings/sess1/s1.wav', 'references/sess1/s1.audio',
  ]);
  assert.deepEqual((await listContentPaths()).sort(), [
    'inputtext/sess1.txt', 'recordings/sess1/s1.wav', 'references/sess1/s1.audio',
  ]);
});

test('the record keeps its claims and loses its bytes', async () => {
  await storeInline(SESSIONS, oldSession());

  await migrateInlineContent({ hash });

  const [raw] = (await snapshot()).sessions;
  assert.equal(raw.sentences[0].recording, null, 'no bytes in the record');
  assert.equal(raw.sentences[0].recordingHash, 'h-rec', 'the claim is untouched');
  assert.equal(raw.inputText, null);
  assert.equal(raw.inputTextHash, 'h-text');
});

test('reading the session back gives the same content it had before', async () => {
  await storeInline(SESSIONS, oldSession());

  await migrateInlineContent({ hash });

  const session = await getOne('sessions', 'sess1');
  assert.equal(session.inputText, 'hello');
  assert.deepEqual([...new Uint8Array(await session.sentences[0].recording.arrayBuffer())], [1, 2]);
  assert.deepEqual([...new Uint8Array(await session.sentences[0].reference.arrayBuffer())], [3, 4, 5]);
});

test('running it again finds nothing to do', async () => {
  await storeInline(SESSIONS, oldSession());
  await migrateInlineContent({ hash });

  const second = await migrateInlineContent({ hash });

  assert.equal(second.records, 0);
  assert.deepEqual(second.moved, []);
});

test('vocab occurrences come too, keyed by the entry rather than the sentence', async () => {
  await storeInline(VOCAB, {
    id: 'v1', text: 'word', lang: 'en', audioPathKey: 'k1', createdAt: 1, updatedAt: 2,
    sources: [{
      occurrenceId: 'o1', sessionId: 'sess1', sentenceId: 's1',
      sentenceTextSnapshot: 'hi', addedAt: 2, audio: clip([9]), audioHash: 'h-vocab',
    }],
  });

  await migrateInlineContent({ hash });

  assert.deepEqual(await listContentPaths(), ['vocab-audio/k1/o1.audio']);
  const entry = await readOne('vocab-audio/k1/o1.audio');
  assert.equal(entry.hash, 'h-vocab');
});

test('a record with a clip that cannot be read is left alone, bytes and all, and reported', async () => {
  // The state this whole change exists because of: the record says there is a
  // clip, and the read of it fails. Rewriting the record without it would take
  // the only copy of those bytes on this device with it -- and the read that
  // failed may well succeed on a fresh connection, which is the whole
  // behaviour of the defect (see db/content.js).
  await storeInline(SESSIONS, oldSession());
  const dead = {
    materializeBlob: async (blob) => {
      if (blob.size === 3) throw new Error('The object can not be found here');
      return materializeBlob(blob);
    },
  };

  const result = await migrateInlineContent({ hash: dead });

  assert.deepEqual(result.unreadable.map((u) => u.path), ['references/sess1/s1.audio']);
  assert.match(result.unreadable[0].message, /The object can not be found here/);
  assert.deepEqual(result.moved, [], 'and nothing of that record was moved');

  const stored = await raw(SESSIONS, 'sess1');
  assert.equal(stored.sentences[0].referenceHash, 'h-ref', 'still claimed');
  assert.deepEqual([...new Uint8Array(await stored.sentences[0].reference.arrayBuffer())], [3, 4, 5],
    'and the bytes are still where version 1 put them, for the next attempt');
});

test('a record skipped for one bad clip is migrated whole once the read succeeds', async () => {
  // Which is what "safe to run again" has to mean: the next run finds the
  // record exactly as version 1 left it and finishes the job.
  await storeInline(SESSIONS, oldSession());
  let failures = 1;
  const flaky = {
    materializeBlob: async (blob) => {
      if (blob.size === 3 && failures-- > 0) throw new Error('The object can not be found here');
      return materializeBlob(blob);
    },
  };

  await migrateInlineContent({ hash: flaky });
  const second = await migrateInlineContent({ hash: flaky });

  assert.deepEqual(second.unreadable, []);
  assert.deepEqual(second.moved.sort(), ['inputtext/sess1.txt', 'recordings/sess1/s1.wav', 'references/sess1/s1.audio']);
  const session = await getOne('sessions', 'sess1');
  assert.deepEqual([...new Uint8Array(await session.sentences[0].reference.arrayBuffer())], [3, 4, 5],
    'read back through the content store this time');
  assert.equal((await raw(SESSIONS, 'sess1')).sentences[0].reference, null, 'and nothing is left inline');
});

test('an empty database is not a special case', async () => {
  const result = await migrateInlineContent({ hash });
  assert.deepEqual(result, { moved: [], unreadable: [], records: 0 });
});

// ---- placing sessions stored before the library had an arrangement ----

test('assignSortKeys: unplaced sessions are stamped in the order they were being shown', async () => {
  // Which was most-recently-changed first. The point is that the first look
  // after the upgrade is the same list, not a reshuffle.
  await storeInline(SESSIONS, oldSession({ id: 'old', updatedAt: 10, sentences: [], inputText: null, inputTextHash: null }));
  await storeInline(SESSIONS, oldSession({ id: 'newest', updatedAt: 30, sentences: [], inputText: null, inputTextHash: null }));
  await storeInline(SESSIONS, oldSession({ id: 'middle', updatedAt: 20, sentences: [], inputText: null, inputTextHash: null }));

  const outcome = await assignSortKeys();
  assert.equal(outcome.placed, 3);

  const { sessions } = await snapshot();
  const order = sessions.slice().sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1)).map((s) => s.id);
  assert.deepEqual(order, ['newest', 'middle', 'old']);
});

test('assignSortKeys: running again finds nothing to do', async () => {
  await storeInline(SESSIONS, oldSession({ id: 'a', sentences: [], inputText: null, inputTextHash: null }));
  await assignSortKeys();
  const before = (await snapshot()).sessions[0].sortKey;

  assert.deepEqual(await assignSortKeys(), { placed: 0 });
  assert.equal((await snapshot()).sessions[0].sortKey, before);
});

test('assignSortKeys: sessions already placed keep their places, and the rest go below them', async () => {
  // The shape a second device arrives in: a few sessions synced down with
  // positions on them, and its own older ones with none.
  await storeInline(SESSIONS, oldSession({ id: 'synced', sortKey: 'i', sentences: [], inputText: null, inputTextHash: null }));
  await storeInline(SESSIONS, oldSession({ id: 'local', updatedAt: 99, sentences: [], inputText: null, inputTextHash: null }));

  await assignSortKeys();

  const { sessions } = await snapshot();
  const byId = Object.fromEntries(sessions.map((s) => [s.id, s.sortKey]));
  assert.equal(byId.synced, 'i', 'an arrangement that exists is not disturbed');
  assert.ok(byId.local > 'i');
});

test('assignSortKeys: stamping a position is not an edit, so the clocks stay put', async () => {
  // Otherwise this device would outrank a genuine rename made on another one,
  // purely by having upgraded later.
  await storeInline(SESSIONS, oldSession({ id: 'a', updatedAt: 10, metaUpdatedAt: 10, sentences: [], inputText: null, inputTextHash: null }));
  await assignSortKeys();

  const stored = (await snapshot()).sessions[0];
  assert.equal(stored.updatedAt, 10);
  assert.equal(stored.metaUpdatedAt, 10);
});
