// Direct unit coverage for store/entity-schema.js's shared pickFields()/
// sessionMetaUpdatedAt()/sentenceUpdatedAt() -- the single source of truth
// store/backup.js (both directions) and sync/restore.js now build their
// session/sentence/vocab records from, instead of each hand-copying the same
// field list. restore.js itself has no unit coverage (it's a thin wrapper
// around real Azure network calls), so this file is what actually exercises
// the shared logic restore.js depends on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_FIELDS, SESSION_OPTIONAL_FIELDS,
  SENTENCE_FIELDS, SENTENCE_OPTIONAL_FIELDS,
  VOCAB_ENTRY_FIELDS, VOCAB_SOURCE_FIELDS, VOCAB_SOURCE_OPTIONAL_FIELDS,
  pickFields, sessionMetaUpdatedAt, sentenceUpdatedAt,
} from '../js/store/entity-schema.js';

test('pickFields: copies required fields through as-is, applies optional fields\' fallback via ??', () => {
  const out = pickFields(
    { id: 'x', name: 'X', extra: 'dropped' },
    ['id', 'name'],
    { folderId: null },
  );
  assert.deepEqual(out, { id: 'x', name: 'X', folderId: null });
});

test('pickFields: optional fallback uses ?? not || -- 0 and false survive, only null/undefined fall back', () => {
  const out = pickFields(
    {
      sourceOffsetMs: 0, hidden: false, referenceSource: null, words: undefined,
    },
    [],
    {
      sourceOffsetMs: -1, hidden: true, referenceSource: 'fallback', words: 'fallback',
    },
  );
  assert.deepEqual(out, {
    sourceOffsetMs: 0, hidden: false, referenceSource: 'fallback', words: 'fallback',
  });
});

test('pickFields: matches the real SESSION_FIELDS/SESSION_OPTIONAL_FIELDS shape backup.js and restore.js both consume', () => {
  const session = {
    id: 's1', name: 'S', splitMode: 'auto', createdAt: 1, updatedAt: 2, extraInternalField: 'nope',
  };
  const out = pickFields(session, SESSION_FIELDS, SESSION_OPTIONAL_FIELDS);
  assert.deepEqual(out, {
    id: 's1', name: 'S', splitMode: 'auto', createdAt: 1, updatedAt: 2,
    folderId: null, inputTextHash: null, sourceAudioHash: null,
  });
});

test('pickFields: matches the real SENTENCE_FIELDS/SENTENCE_OPTIONAL_FIELDS shape, sourceOffsetMs=0 preserved', () => {
  const sentence = {
    id: 'w1', text: 'hi', lang: 'en', hidden: false, sourceOffsetMs: 0, sourceDurationMs: 500,
  };
  const out = pickFields(sentence, SENTENCE_FIELDS, SENTENCE_OPTIONAL_FIELDS);
  assert.equal(out.sourceOffsetMs, 0);
  assert.equal(out.sourceDurationMs, 500);
  assert.equal(out.hidden, false);
  assert.equal(out.recordingHash, null);
  assert.equal(out.referenceSource, null);
});

test('sessionMetaUpdatedAt: prefers metaUpdatedAt, falls back through updatedAt then createdAt then 0', () => {
  assert.equal(sessionMetaUpdatedAt({ metaUpdatedAt: 3, updatedAt: 2, createdAt: 1 }), 3);
  assert.equal(sessionMetaUpdatedAt({ updatedAt: 2, createdAt: 1 }), 2);
  assert.equal(sessionMetaUpdatedAt({ createdAt: 1 }), 1);
  assert.equal(sessionMetaUpdatedAt({}), 0);
});

test('sentenceUpdatedAt: prefers its own updatedAt, else falls back to the parent session\'s', () => {
  const session = { updatedAt: 20, createdAt: 10 };
  assert.equal(sentenceUpdatedAt({ updatedAt: 30 }, session), 30);
  assert.equal(sentenceUpdatedAt({}, session), 20);
  assert.equal(sentenceUpdatedAt({}, { createdAt: 10 }), 10);
  assert.equal(sentenceUpdatedAt({}, {}), 0);
});

// VOCAB_ENTRY_FIELDS/VOCAB_SOURCE_FIELDS/VOCAB_SOURCE_OPTIONAL_FIELDS were the
// specific field lists this file's own module comment says already dropped a
// field once (by hand-copying) before entity-schema.js existed -- yet were
// the one part of the unification never directly exercised here. Covered
// directly now, same shape store/backup.js, sync/restore.js, and
// sync/azure-sync.js's manifest builder all three actually consume.
test('pickFields: matches the real VOCAB_ENTRY_FIELDS shape backup.js/restore.js/azure-sync.js all consume', () => {
  const entry = {
    id: 'hello', text: 'hello', lang: 'en', audioPathKey: 'key1', createdAt: 1, updatedAt: 2, sources: 'dropped, not in VOCAB_ENTRY_FIELDS',
  };
  const out = pickFields(entry, VOCAB_ENTRY_FIELDS);
  assert.deepEqual(out, {
    id: 'hello', text: 'hello', lang: 'en', audioPathKey: 'key1', createdAt: 1, updatedAt: 2,
  });
});

test('pickFields: matches the real VOCAB_SOURCE_FIELDS/VOCAB_SOURCE_OPTIONAL_FIELDS shape, audioHash=null default preserved and audioBlob dropped', () => {
  const source = {
    occurrenceId: 'occ-1', sessionId: 's1', sentenceId: 'sent1', sentenceTextSnapshot: 'Hi.', addedAt: 5, audioBlob: 'dropped, not in the field lists',
  };
  const out = pickFields(source, VOCAB_SOURCE_FIELDS, VOCAB_SOURCE_OPTIONAL_FIELDS);
  assert.deepEqual(out, {
    occurrenceId: 'occ-1', sessionId: 's1', sentenceId: 'sent1', sentenceTextSnapshot: 'Hi.', addedAt: 5, audioHash: null,
  });
});

test('pickFields: VOCAB_SOURCE_OPTIONAL_FIELDS\' audioHash uses ?? -- a real (non-null) hash is never overwritten by the fallback', () => {
  const source = {
    occurrenceId: 'occ-1', sessionId: null, sentenceId: null, sentenceTextSnapshot: null, addedAt: 5, audioHash: 'realhash',
  };
  const out = pickFields(source, VOCAB_SOURCE_FIELDS, VOCAB_SOURCE_OPTIONAL_FIELDS);
  assert.equal(out.audioHash, 'realhash');
});
