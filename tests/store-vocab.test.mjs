import './setup-indexeddb.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetStores } from './store-test-helpers.mjs';
import {
  normalizeVocabText, getVocabEntry, listVocab, addVocabOccurrence,
  upsertVocab, removeVocabRecord, deleteVocabEntry,
} from '../js/store/vocab.js';
import { listTombstones } from '../js/store/tombstones.js';

beforeEach(resetStores);

test('normalizeVocabText: strips whitespace/punctuation/symbols and lowercases, per the stated dedup rule', () => {
  assert.equal(normalizeVocabText('Hello, world!'), 'helloworld');
  assert.equal(normalizeVocabText('hello world'), 'helloworld');
  assert.equal(normalizeVocabText('  Ambiguous.  '), 'ambiguous');
  assert.equal(normalizeVocabText(''), '');
  assert.equal(normalizeVocabText(null), '');
  // Pure punctuation/whitespace normalizes to nothing -- callers (e.g.
  // addVocabOccurrence) reject this rather than create a blank-id entry.
  assert.equal(normalizeVocabText('  ,.!  '), '');
});

test('addVocabOccurrence: first occurrence creates a new entry keyed by normalized text', async () => {
  const entry = await addVocabOccurrence('Hello, world!', 'en', {
    sessionId: 'sess1', sentenceId: 'sent1', sentenceTextSnapshot: 'Hello, world! Nice day.',
  });
  assert.equal(entry.id, 'helloworld');
  assert.equal(entry.text, 'Hello, world!');
  assert.equal(entry.lang, 'en');
  assert.match(entry.audioPathKey, /^[0-9a-f]{64}$/);
  assert.equal(entry.sources.length, 1);
  assert.equal(entry.sources[0].sessionId, 'sess1');
  assert.equal(entry.sources[0].sentenceTextSnapshot, 'Hello, world! Nice day.');
  assert.equal(entry.sources[0].hasAudio, false);
  assert.match(entry.sources[0].occurrenceId, /^[0-9a-f]{8}-[0-9a-f]{4}-/i);

  const fetched = await getVocabEntry('helloworld');
  assert.equal(fetched.id, 'helloworld');
});

test('addVocabOccurrence: returns null for text that normalizes to nothing', async () => {
  const entry = await addVocabOccurrence('  ,.!  ', 'en', {});
  assert.equal(entry, null);
  assert.deepEqual(await listVocab(), []);
});

test('addVocabOccurrence: a second occurrence of the same normalized text appends to sources[] instead of creating a new entry', async () => {
  await addVocabOccurrence('Hello, world!', 'en', { sessionId: 'sess1', sentenceId: 'sent1' });
  const entry = await addVocabOccurrence('hello world', 'en', { sessionId: 'sess2', sentenceId: 'sent9' });
  assert.equal(entry.id, 'helloworld');
  assert.equal(entry.sources.length, 2);
  assert.equal(entry.sources[1].sessionId, 'sess2');

  const all = await listVocab();
  assert.equal(all.length, 1);
});

test('addVocabOccurrence: hashes a real audio Blob byte-for-byte via hashBlob, not by misreading it as text', async () => {
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 10, 13]); // includes bytes invalid as UTF-8/text
  const audioBlob = new Blob([bytes], { type: 'audio/wav' });
  const entry = await addVocabOccurrence('test', 'en', { audioBlob });
  assert.equal(entry.sources[0].hasAudio, true);
  assert.match(entry.sources[0].audioHash, /^[0-9a-f]{64}$/);

  // Re-fetching and re-appending must not throw the Chromium
  // "Error preparing Blob/File data to be stored in object store" error --
  // this exercises the rewrap-before-re-put fix in addVocabOccurrence().
  const again = await addVocabOccurrence('test', 'en', { audioBlob: new Blob([bytes], { type: 'audio/wav' }) });
  assert.equal(again.sources.length, 2);
});

test('listVocab: sorts newest-first by updatedAt', async () => {
  await addVocabOccurrence('aaa', 'en', {});
  await new Promise((r) => setTimeout(r, 2));
  await addVocabOccurrence('bbb', 'en', {});
  const all = await listVocab();
  assert.deepEqual(all.map((e) => e.id), ['bbb', 'aaa']);
});

test('upsertVocab: merge-writes already-resolved entries as-is, rewrapping any audioBlob for the fresh transaction', async () => {
  const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
  await upsertVocab([
    {
      id: 'merged', text: 'merged', lang: 'en', audioPathKey: 'k1', createdAt: 1, updatedAt: 1,
      sources: [{ occurrenceId: 'o1', hasAudio: true, audioHash: 'h1', audioBlob }],
    },
  ]);
  const entry = await getVocabEntry('merged');
  assert.equal(entry.sources[0].occurrenceId, 'o1');
  assert.equal(entry.sources[0].audioBlob.type, 'audio/wav');
});

test('upsertVocab: no-op on empty/undefined list', async () => {
  await upsertVocab(undefined);
  await upsertVocab([]);
  assert.deepEqual(await listVocab(), []);
});

test('removeVocabRecord: deletes the record without recording a tombstone', async () => {
  await addVocabOccurrence('gone', 'en', {});
  await removeVocabRecord('gone');
  assert.equal(await getVocabEntry('gone'), undefined);
  assert.deepEqual(await listTombstones(), []);
});

test('deleteVocabEntry: deletes the record and records a "vocab"-kind tombstone', async () => {
  await addVocabOccurrence('gone', 'en', {});
  await deleteVocabEntry('gone');
  assert.equal(await getVocabEntry('gone'), undefined);
  const tombstones = await listTombstones();
  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0].id, 'vocab:gone');
  assert.equal(tombstones[0].kind, 'vocab');
  assert.equal(tombstones[0].targetId, 'gone');
});
