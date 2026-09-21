import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  addOccurrence, list, removeEntry, rangeOfWords, selectionHasRealAudio,
  pickOccurrenceAudio, sourceSentenceAudio,
} from '../../js/app/commands/vocab.js';
import { createSessionStore } from '../../js/app/store.js';
import { saveRecord } from '../../js/app/persist.js';
import * as db from '../../js/db/entities.js';
import { transact, ALL_STORES, request } from '../../js/db/open.js';
import { blankSentence } from '../../js/model/session.js';
import { hashBlob, hashString, hashJson, materializeBlob } from '../../js/platform/hash.js';
import { seed } from '../helpers/seed.mjs';

const clip = (bytes) => new Blob([new Uint8Array(bytes)], { type: 'audio/wav' });
const word = (charStart, charEnd, offsetMs, durationMs) => ({ charStart, charEnd, offsetMs, durationMs });

const session = (sentences, over = {}) => ({
  id: 'sess1', name: null, folderId: null, splitMode: 'auto',
  createdAt: 1, updatedAt: 1, metaUpdatedAt: 1,
  inputText: null, inputTextHash: null, sourceAudio: null, sourceAudioHash: null,
  sentences, ...over,
});

const sentence = (id, text, over = {}) => blankSentence({ id, text, lang: 'en', now: 1, ...over });

function harness({ sentences, sessionOver = {}, credentials = true, decodeFails = false } = {}) {
  let n = 0;
  const synthesized = [];
  return {
    store: createSessionStore(session(sentences ?? [sentence('s1', 'This is difficult.')], sessionOver)),
    synthesized,
    deps: {
      db,
      hash: { hashBlob, hashString, hashJson, materializeBlob },
      saveRecord,
      ids: () => `occ-${++n}`,
      clock: () => 1000,
      settings: { hasCredentials: () => credentials, voice: (locale) => `voice-${locale}` },
      speech: () => ({
        synthesize: async (text) => { synthesized.push(text); return clip([7, 7]); },
      }),
      audio: {
        decode: async () => {
          if (decodeFails) throw new Error('bad file');
          return { channelData: new Float32Array(16_000), sampleRate: 16_000 };
        },
        cutClip: (_decoded, range) => clip([range.offsetMs & 0xff]),
      },
    },
  };
}

beforeEach(async () => {
  await transact(ALL_STORES, 'readwrite', async (stores) => {
    for (const name of ALL_STORES) await request(stores[name].clear());
  });
});

test('rangeOfWords: spans the first word to the end of the last', () => {
  assert.deepEqual(rangeOfWords([word(0, 4, 1000, 200), word(5, 9, 1400, 300)]), { offsetMs: 1000, durationMs: 700 });
});

test('rangeOfWords: a word with no timing means no range, not a partial one', () => {
  assert.equal(rangeOfWords([word(0, 4, null, 200)]), null);
  assert.equal(rangeOfWords([word(0, 4, 1000, 200), word(5, 9, null, null)]), null);
  assert.equal(rangeOfWords([]), null);
  assert.equal(rangeOfWords(null), null);
});

test('rangeOfWords: a zero-length span is refused', () => {
  assert.equal(rangeOfWords([word(0, 4, 1000, 0)]), null);
});

test('adds an entry keyed by the normalised text', async () => {
  const h = harness();
  const result = await addOccurrence({
    store: h.store, sentenceId: 's1', words: [word(8, 18, null, null)], deps: h.deps,
  });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.id, 'difficult');

  const [entry] = await db.listAll('vocab');
  assert.equal(entry.text, 'difficult.');
  assert.equal(entry.id, 'difficult', 'punctuation and case do not make a second entry');
});

test('a second sighting appends an occurrence rather than making another entry', async () => {
  const h = harness();
  await addOccurrence({ store: h.store, sentenceId: 's1', words: [word(8, 18, null, null)], deps: h.deps });

  h.store.replace(session([sentence('s2', 'Difficult again.')]));
  const result = await addOccurrence({ store: h.store, sentenceId: 's2', words: [word(0, 10, null, null)], deps: h.deps });

  assert.equal(result.created, false);
  assert.equal(result.occurrences, 2);
  assert.equal((await db.listAll('vocab')).length, 1);
});

test('each occurrence keeps the sentence it came from, so it survives that sentence', async () => {
  const h = harness();
  await addOccurrence({ store: h.store, sentenceId: 's1', words: [word(8, 18, null, null)], deps: h.deps });

  const [entry] = await db.listAll('vocab');
  assert.equal(entry.sources[0].sentenceTextSnapshot, 'This is difficult.');
  assert.equal(entry.sources[0].sessionId, 'sess1');
  assert.equal(entry.sources[0].sentenceId, 's1');
});

test('the audio path key is derived once from the id', async () => {
  const h = harness();
  await addOccurrence({ store: h.store, sentenceId: 's1', words: [word(8, 18, null, null)], deps: h.deps });
  const [entry] = await db.listAll('vocab');
  assert.equal(entry.audioPathKey, await hashString('difficult'));
});

test('the path key does not change when a second occurrence is added', async () => {
  // Changing it would strand every clip already stored under the old one.
  const h = harness();
  await addOccurrence({ store: h.store, sentenceId: 's1', words: [word(8, 18, null, null)], deps: h.deps });
  const first = (await db.listAll('vocab'))[0].audioPathKey;

  await addOccurrence({ store: h.store, sentenceId: 's1', words: [word(8, 18, null, null)], deps: h.deps });
  assert.equal((await db.listAll('vocab'))[0].audioPathKey, first);
});

test('a word from an imported sentence is cut from the source file, not synthesized', async () => {
  const h = harness({
    sentences: [sentence('s1', 'This is difficult.', {
      referenceSource: 'import', sourceOffsetMs: 1000, sourceDurationMs: 2000,
      words: [word(8, 18, 1500, 400)],
    })],
    sessionOver: { splitMode: 'audio', sourceAudio: 'SOURCE_FILE' },
  });

  const result = await addOccurrence({ store: h.store, sentenceId: 's1', words: [word(8, 18, 1500, 400)], deps: h.deps });

  assert.equal(result.ok, true);
  assert.deepEqual(h.synthesized, [], 'real audio beats an imitation');
  const [entry] = await db.listAll('vocab');
  assert.ok(entry.sources[0].audio);
  assert.ok(entry.sources[0].audioHash, 'and it is stamped for sync');
});

test('a word with no timings falls back to synthesis', async () => {
  const h = harness();
  await addOccurrence({ store: h.store, sentenceId: 's1', words: [word(8, 18, null, null)], deps: h.deps });

  assert.deepEqual(h.synthesized, ['difficult.']);
  const [entry] = await db.listAll('vocab');
  assert.ok(entry.sources[0].audio);
});

test('an undecodable source falls back to synthesis rather than refusing the entry', async () => {
  const h = harness({
    sentences: [sentence('s1', 'This is difficult.', { referenceSource: 'import', sourceOffsetMs: 0, sourceDurationMs: 2000 })],
    sessionOver: { sourceAudio: 'CORRUPT' },
    decodeFails: true,
  });

  const result = await addOccurrence({ store: h.store, sentenceId: 's1', words: [word(8, 18, 500, 400)], deps: h.deps });

  assert.equal(result.ok, true);
  assert.deepEqual(h.synthesized, ['difficult.']);
});

test('without credentials a text-only occurrence is still kept', async () => {
  const h = harness({ credentials: false });
  const result = await addOccurrence({ store: h.store, sentenceId: 's1', words: [word(8, 18, null, null)], deps: h.deps });

  assert.equal(result.ok, true);
  const [entry] = await db.listAll('vocab');
  assert.equal(entry.sources[0].audio, null);
  assert.equal(entry.sources[0].audioHash, null, 'and it claims no clip');
});

test('a selection that normalises to nothing is refused', async () => {
  const h = harness({ sentences: [sentence('s1', 'Hello ... there')] });
  const result = await addOccurrence({ store: h.store, sentenceId: 's1', words: [word(6, 9, null, null)], deps: h.deps });
  assert.deepEqual(result, { ok: false, reason: 'not-a-word' });
});

test('an empty selection, or a sentence that is gone, is refused', async () => {
  const h = harness();
  assert.equal((await addOccurrence({ store: h.store, sentenceId: 's1', words: [], deps: h.deps })).reason, 'no-selection');
  assert.equal((await addOccurrence({ store: h.store, sentenceId: 'nope', words: [word(0, 4, null, null)], deps: h.deps })).reason, 'gone');
});

test('selectionHasRealAudio: true only when the selection lies inside the sentence\'s own slice', () => {
  const imported = sentence('s1', 'x', { referenceSource: 'import', sourceOffsetMs: 1000, sourceDurationMs: 1000 });
  assert.equal(selectionHasRealAudio(imported, [word(0, 1, 1200, 300)]), true);
  assert.equal(selectionHasRealAudio(imported, [word(0, 1, 900, 300)]), false, 'starts before the slice');
  assert.equal(selectionHasRealAudio(imported, [word(0, 1, 1800, 400)]), false, 'runs past the slice');
  assert.equal(selectionHasRealAudio(imported, [word(0, 1, null, null)]), false);
  assert.equal(selectionHasRealAudio(sentence('s1', 'x'), [word(0, 1, 100, 100)]), false, 'not an imported sentence');
});

test('list: newest first', async () => {
  await seed('vocab', { id: 'old', text: 'old', audioPathKey: 'k1', createdAt: 1, updatedAt: 100, sources: [] });
  await seed('vocab', { id: 'new', text: 'new', audioPathKey: 'k2', createdAt: 1, updatedAt: 900, sources: [] });

  assert.deepEqual((await list({ deps: { db } })).map((e) => e.id), ['new', 'old']);
});

test('removeEntry: deletes the record and its tombstone together', async () => {
  await seed('vocab', { id: 'word', text: 'word', audioPathKey: 'k', createdAt: 1, updatedAt: 1, sources: [] });

  await removeEntry({ id: 'word', deps: { db } });

  assert.deepEqual(await db.listAll('vocab'), []);
  assert.ok((await db.listTombstones()).some((t) => t.id === 'vocab:word'), 'so it cannot return on the next sync');
});

test('pickOccurrenceAudio: chooses among the occurrences that have audio', () => {
  const entry = {
    sources: [
      { occurrenceId: 'a', audio: null },
      { occurrenceId: 'b', audio: 'CLIP_B' },
      { occurrenceId: 'c', audio: 'CLIP_C' },
    ],
  };
  assert.equal(pickOccurrenceAudio(entry, () => 0).occurrenceId, 'b');
  assert.equal(pickOccurrenceAudio(entry, () => 0.99).occurrenceId, 'c');
});

test('pickOccurrenceAudio: an entry with no audio at all yields null', () => {
  assert.equal(pickOccurrenceAudio({ sources: [{ occurrenceId: 'a', audio: null }] }), null);
  assert.equal(pickOccurrenceAudio({ sources: [] }), null);
  assert.equal(pickOccurrenceAudio(null), null);
});

test('sourceSentenceAudio: returns the sentence\'s reference, never the user\'s own take', async () => {
  // The point is hearing how it should sound.
  await seed('sessions', session([sentence('s1', 'x', { reference: clip([1, 1, 1]), recording: clip([2, 2, 2]) })]));

  const audio = await sourceSentenceAudio({ occurrence: { sessionId: 'sess1', sentenceId: 's1' }, deps: { db } });
  assert.deepEqual([...new Uint8Array(await audio.arrayBuffer())], [1, 1, 1], 'the reference, not the take');
});

test('sourceSentenceAudio: a session or sentence that is gone yields null, which is ordinary', async () => {
  assert.equal(await sourceSentenceAudio({ occurrence: { sessionId: 'deleted', sentenceId: 's1' }, deps: { db } }), null);

  await seed('sessions', session([sentence('other', 'x')]));
  assert.equal(await sourceSentenceAudio({ occurrence: { sessionId: 'sess1', sentenceId: 'split-away' }, deps: { db } }), null);
  assert.equal(await sourceSentenceAudio({ occurrence: {}, deps: { db } }), null);
});
