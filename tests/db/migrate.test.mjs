// The one-time move of version 1's inline content into the content store,
// driven against records written the way version 1 wrote them.
import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { migrateInlineContent } from '../../js/db/migrate.js';
import { getOne, snapshot } from '../../js/db/entities.js';
import { listContentPaths, readOne } from '../../js/db/content.js';
import { SESSIONS, VOCAB, ALL_STORES, transact, request } from '../../js/db/open.js';
import { materializeBlob } from '../../js/platform/hash.js';

const hash = { materializeBlob };
const clip = (bytes) => new Blob([new Uint8Array(bytes)], { type: 'audio/wav' });

/** A write of the kind version 1 made: the bytes live inside the record. */
const storeInline = (store, record) => transact([store], 'readwrite', (s) => request(s[store].put(record)));

const oldSession = (over = {}) => ({
  id: 'sess1', name: null, folderId: null, splitMode: 'auto',
  createdAt: 1, updatedAt: 10, metaUpdatedAt: 10,
  inputText: 'hello', inputTextHash: 'h-text',
  sourceAudio: null, sourceAudioHash: null,
  sentences: [{
    id: 's1', text: 'hi', lang: 'en', hidden: false, updatedAt: 10,
    words: null, manualPoints: null, referenceSource: 'tts',
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

test('a clip whose bytes cannot be read is reported, and its sentence still claims it', async () => {
  // The state this whole change exists because of: the record says there is a
  // clip, and the bytes behind it are gone. Migration is not the moment to
  // decide that means the clip never existed.
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

  const session = await getOne('sessions', 'sess1');
  assert.equal(session.sentences[0].referenceHash, 'h-ref', 'still claimed');
  assert.equal(session.sentences[0].reference, null, 'and unplayable, which is the truth');
  assert.deepEqual([...new Uint8Array(await session.sentences[0].recording.arrayBuffer())], [1, 2],
    'the rest of the session came through');
});

test('an empty database is not a special case', async () => {
  const result = await migrateInlineContent({ hash });
  assert.deepEqual(result, { moved: [], unreadable: [], records: 0 });
});
