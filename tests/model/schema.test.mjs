import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  entity, f, hashKey, toNode, fromNode, walkContent, mapContent, dropContent,
  SESSION, SENTENCE, VOCAB_ENTRY, OCCURRENCE,
} from '../../js/model/schema.js';

// The simplest entity there is: an id and flat fields, nothing nested, no
// content. Declared here rather than borrowed from a production entity, so a
// test about the generic machinery does not quietly depend on one of the real
// definitions staying simple.
const PLAIN = entity('plain', {
  id: f.id(),
  name: f.plain({ default: null }),
  parentId: f.plain({ default: null }),
  createdAt: f.plain({ default: 0 }),
  updatedAt: f.plain({ default: 0 }),
});
import { contentPath } from '../../js/model/content.js';

test('entity: refuses a definition with no id field', () => {
  assert.throws(() => entity('broken', { name: f.plain() }), /no f\.id\(\)/);
});

test('entity: clock defaults to updatedAt, metaClock defaults to clock', () => {
  const e = entity('x', { id: f.id() });
  assert.equal(e.clock, 'updatedAt');
  assert.equal(e.metaClock, 'updatedAt');
  assert.equal(SESSION.metaClock, 'metaUpdatedAt');
  assert.equal(SESSION.clock, 'updatedAt');
});

test('toNode: content becomes a hash only -- no value, and no has-flag anywhere', () => {
  const node = toNode(SENTENCE, {
    id: 's1', text: 'hi', lang: 'en', hidden: false,
    recording: new Uint8Array([1]), recordingHash: 'rh',
    reference: null, referenceHash: null,
  });
  assert.equal(node.recordingHash, 'rh');
  assert.equal(node.referenceHash, null);
  assert.equal('recording' in node, false, 'the value itself never travels');
  assert.equal('hasRecording' in node, false, 'a has-flag is a second copy of the hash');
});

test('toNode: defaults apply with ?? -- 0 and false survive, only null/undefined fall back', () => {
  const node = toNode(SENTENCE, {
    id: 's1', text: '', lang: null, hidden: false, sourceOffsetMs: 0, sourceDurationMs: undefined,
  });
  assert.equal(node.hidden, false, 'false is a real value for hidden');
  assert.equal(node.sourceOffsetMs, 0, 'the very start of the source audio is a real offset');
  assert.equal(node.sourceDurationMs, null, 'undefined falls back');
  assert.equal(node.lang, null);
});

test('toNode: key order follows the declaration, so equal data serializes identically', () => {
  const a = toNode(PLAIN, { id: 1, name: 'A', parentId: null, createdAt: 1, updatedAt: 2 });
  const b = toNode(PLAIN, { updatedAt: 2, createdAt: 1, parentId: null, name: 'A', id: 1 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('toNode: recurses into children', () => {
  const node = toNode(SESSION, {
    id: 'sess', name: null, splitMode: 'auto', createdAt: 1, updatedAt: 2, metaUpdatedAt: 2,
    inputTextHash: 'ih',
    sentences: [{ id: 'a', text: 'one', recordingHash: 'rh' }],
  });
  assert.equal(node.sentences.length, 1);
  assert.equal(node.sentences[0].recordingHash, 'rh');
  assert.equal(node.inputTextHash, 'ih');
});

test('fromNode: round-trips plain fields and hashes, leaving content values null to be filled', () => {
  const record = {
    id: 'sess', name: 'S', splitMode: 'audio', createdAt: 1, updatedAt: 5, metaUpdatedAt: 4,
    inputText: 'text', inputTextHash: 'ih', sourceAudio: null, sourceAudioHash: null,
    sentences: [{
      id: 'a', text: 'one', lang: 'ja', hidden: true, sourceOffsetMs: 0, sourceDurationMs: 400,
      recording: 'BYTES', recordingHash: 'rh', reference: null, referenceHash: null, assessment: null, assessmentHash: null,
    }],
  };
  const back = fromNode(SESSION, toNode(SESSION, record));
  assert.equal(back.inputText, null, 'content value is not invented');
  assert.equal(back.inputTextHash, 'ih');
  assert.equal(back.sentences[0].recording, null);
  assert.equal(back.sentences[0].recordingHash, 'rh');
  assert.equal(back.sentences[0].hidden, true);
  assert.equal(back.sentences[0].sourceOffsetMs, 0);
  assert.equal(back.splitMode, 'audio');
});

test('walkContent: yields every slot in the tree, with refs that resolve to blob paths', () => {
  const session = {
    id: 'sess1', inputTextHash: 'ih', inputText: 'x', sourceAudioHash: null, sourceAudio: null,
    sentences: [{ id: 'sent1', recordingHash: 'rh', recording: 'R', referenceHash: 'fh', reference: 'F', assessmentHash: null, assessment: null }],
  };
  const slots = [...walkContent(SESSION, session)];
  assert.deepEqual(slots.map((s) => s.kind), [
    'inputText', 'sourceAudio', 'recording', 'reference', 'assessment',
  ]);
  const recording = slots.find((s) => s.kind === 'recording');
  assert.equal(contentPath(recording.kind, recording.ref), 'recordings/sess1/sent1.wav');
  const inputText = slots.find((s) => s.kind === 'inputText');
  assert.equal(contentPath(inputText.kind, inputText.ref), 'inputtext/sess1.txt');
});

test('walkContent: a vocab occurrence is keyed by the entry, not by the sentence it came from', () => {
  const entry = {
    id: 'hello', text: 'hello', audioPathKey: 'k1',
    sources: [{ occurrenceId: 'occ1', sessionId: 'gone', sentenceId: 'also-gone', audioHash: 'ah', audio: 'A' }],
  };
  const [slot] = [...walkContent(VOCAB_ENTRY, entry)];
  assert.equal(slot.kind, 'vocabAudio');
  assert.equal(contentPath(slot.kind, slot.ref), 'vocab-audio/k1/occ1.audio');
});

test('mapContent: fills every content slot in the tree, children included', () => {
  const session = {
    id: 'sess1', inputTextHash: 'ih', inputText: null, sourceAudioHash: null, sourceAudio: null,
    sentences: [{ id: 'sent1', recordingHash: 'rh', recording: null, referenceHash: null, reference: null, assessmentHash: null, assessment: null }],
  };
  const filled = mapContent(SESSION, session, (slot) => (slot.hash ? `BYTES:${slot.kind}` : null));

  assert.equal(filled.inputText, 'BYTES:inputText');
  assert.equal(filled.sourceAudio, null);
  assert.equal(filled.sentences[0].recording, 'BYTES:recording');
  assert.equal(filled.sentences[0].reference, null);
});

test('mapContent: the slot carries the ref, so a caller can look content up by path', () => {
  const seen = [];
  mapContent(SESSION, {
    id: 'sess1', inputTextHash: null, sourceAudioHash: null,
    sentences: [{ id: 'sent1', recordingHash: 'rh' }],
  }, (slot) => { seen.push([slot.kind, slot.ref.sessionId, slot.ref.sentenceId]); return null; });

  assert.deepEqual(seen, [
    ['inputText', 'sess1', undefined],
    ['sourceAudio', 'sess1', undefined],
    ['recording', 'sess1', 'sent1'],
    ['reference', 'sess1', 'sent1'],
    ['assessment', 'sess1', 'sent1'],
  ]);
});

test('mapContent: leaves hashes and plain fields alone, and does not mutate its input', () => {
  const before = { id: 'sess1', name: 'Keep', inputTextHash: 'ih', inputText: 'old', sourceAudioHash: null, sentences: [] };
  const snapshot = JSON.stringify(before);
  const after = mapContent(SESSION, before, () => 'NEW');

  assert.equal(after.inputTextHash, 'ih');
  assert.equal(after.name, 'Keep');
  assert.equal(JSON.stringify(before), snapshot);
});

test('mapContent and walkContent visit exactly the same slots', () => {
  const entry = {
    id: 'w', text: 'w', audioPathKey: 'k',
    sources: [{ occurrenceId: 'o1', audioHash: 'a1' }, { occurrenceId: 'o2', audioHash: null }],
  };
  const walked = [...walkContent(VOCAB_ENTRY, entry)].map((s) => `${s.kind}:${s.ref.occurrenceId}`);
  const mapped = [];
  mapContent(VOCAB_ENTRY, entry, (s) => { mapped.push(`${s.kind}:${s.ref.occurrenceId}`); return s.value; });

  assert.deepEqual(mapped, walked);
});

test('hashKey: one naming rule for every content field', () => {
  assert.equal(hashKey('recording'), 'recordingHash');
  assert.equal(hashKey('audio'), 'audioHash');
});

test('adding a content field reaches the manifest and the content walk with no other change', () => {
  // The property the whole schema exists for: one declaration, every
  // representation. A field added here must show up in toNode and in
  // walkContent without either being touched.
  const WITH_EXTRA = entity('sentenceish', {
    id: f.id(),
    updatedAt: f.plain({ default: 0 }),
    recording: f.content('recording'),
    extra: f.content('assessment'),
  }, { ref: (r, p) => ({ ...p, sentenceId: r.id }) });

  const node = toNode(WITH_EXTRA, { id: 'x', recordingHash: 'a', extraHash: 'b' });
  assert.deepEqual(node, { id: 'x', updatedAt: 0, recordingHash: 'a', extraHash: 'b' });
  assert.deepEqual([...walkContent(WITH_EXTRA, { id: 'x', recordingHash: 'a', extraHash: 'b' })].map((s) => s.field),
    ['recording', 'extra']);
});

test('dropContent: empties the selected slots, value and hash together', () => {
  const session = {
    id: 'sess1',
    inputText: 'hello', inputTextHash: 'h1',
    sourceAudio: { size: 1 }, sourceAudioHash: 'h2',
    sentences: [{ id: 's1', recording: { size: 2 }, recordingHash: 'h3', reference: { size: 3 }, referenceHash: 'h4' }],
  };

  const out = dropContent(SESSION, session, (slot) => (
    contentPath(slot.kind, slot.ref) === 'references/sess1/s1.audio'
  ));

  assert.equal(out.sentences[0].reference, null);
  assert.equal(out.sentences[0].referenceHash, null, 'the claim goes with the bytes');
  assert.equal(out.sentences[0].recordingHash, 'h3', 'and nothing else is touched');
  assert.equal(out.inputTextHash, 'h1');
  assert.equal(out.sourceAudioHash, 'h2');
});

test('dropContent: an empty slot is never offered to the predicate', () => {
  const asked = [];
  const out = dropContent(SESSION, { id: 'sess1', inputTextHash: null, sentences: [] }, (slot) => {
    asked.push(slot.field);
    return true;
  });
  assert.deepEqual(asked, []);
  assert.equal(out.id, 'sess1');
});

test('dropContent: what it drops is exactly what stops being walked', () => {
  const session = {
    id: 'sess1',
    inputText: 'hello', inputTextHash: 'h1',
    sentences: [{ id: 's1', recording: { size: 2 }, recordingHash: 'h3' }],
  };

  const out = dropContent(SESSION, session, (slot) => slot.kind === 'recording');

  const held = [...walkContent(SESSION, out)].filter((slot) => slot.hash !== null);
  assert.deepEqual(held.map((s) => s.field), ['inputText']);
});

// The discipline every entity is written to, checked over the definitions
// themselves rather than trusted. Each of these was a convention with nothing
// enforcing it, which is the state a rule is in just before it is broken.
const ENTITIES = { SESSION, SENTENCE, VOCAB_ENTRY, OCCURRENCE };

test('no entity carries a has<Something> flag', () => {
  // A hash is non-null exactly when content exists, so a boolean beside it is a
  // second source of truth that can disagree with the first.
  const flags = Object.entries(ENTITIES).flatMap(([name, def]) => def.entries
    .map(([field]) => field)
    .filter((field) => /^has[A-Z]/.test(field))
    .map((field) => `${name}.${field}`));

  assert.deepEqual(flags, []);
});

test('every content field is paired with its hash, and nothing else ends in Hash', () => {
  for (const [name, def] of Object.entries(ENTITIES)) {
    const content = def.entries.filter(([, d]) => d.role === 'content').map(([field]) => hashKey(field));
    const plainHashes = def.entries
      .filter(([field, d]) => d.role !== 'content' && /Hash$/.test(field))
      .map(([field]) => field);

    assert.deepEqual(plainHashes.filter((field) => !content.includes(field)), [],
      `${name} declares a Hash field with no content field behind it`);
  }
});

/**
 * Which fields have no default, and so must be supplied.
 *
 * Pinned rather than derived: a field with no default comes out `undefined`,
 * and `undefined` is the one value that does not survive JSON -- the key is
 * simply not in the manifest. That is fine for identity, where a record
 * without one is not a record, and it is a hole anywhere else. Adding a field
 * without a default therefore has to come through this list, deliberately.
 */
const REQUIRED = {
  SESSION: ['id'],
  SENTENCE: ['id'],
  VOCAB_ENTRY: ['id', 'audioPathKey'],
  OCCURRENCE: ['occurrenceId'],
};

// A descriptor built by f.plain({ default }) carries that default; one built by
// f.plain() carries undefined, which is exactly the case this pins down.
const required = (def) => def.entries
  .filter(([, d]) => (d.role === 'id' || d.role === 'plain') && d.default === undefined)
  .map(([field]) => field);

test('only identity is required; every other field declares a default', () => {
  for (const [name, def] of Object.entries(ENTITIES)) {
    const supplied = Object.fromEntries(REQUIRED[name].map((field) => [field, 'x']));
    const built = fromNode(def, supplied);
    const missing = def.entries
      .map(([field]) => field)
      .filter((field) => !(field in built) || built[field] === undefined);

    assert.deepEqual(missing, [], `${name}: these came out undefined rather than defaulted`);
    assert.deepEqual(required(def).sort(), [...REQUIRED[name]].sort(),
      `${name}: the set of fields with no default has changed -- see REQUIRED above`);
  }
});

test('identity is never invented: a record without it is not a record', () => {
  for (const [name, def] of Object.entries(ENTITIES)) {
    for (const field of REQUIRED[name]) {
      assert.equal(fromNode(def, {})[field], undefined, `${name} invented ${field}`);
    }
  }
});

test('a node carries no undefined either, so JSON cannot silently drop a field', () => {
  for (const [name, def] of Object.entries(ENTITIES)) {
    const node = toNode(def, Object.fromEntries(REQUIRED[name].map((field) => [field, 'x'])));
    for (const [field, value] of Object.entries(node)) {
      assert.notEqual(value, undefined, `${name}.${field} serialized as undefined`);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(node)), node,
      `${name} does not survive a JSON round-trip unchanged`);
  }
});

test('contentPath: a ref missing a part is refused, not addressed', () => {
  // A path is an address. Interpolating an absent part gives "undefined",
  // which is well-formed, wrong, and the same wrong answer on every device --
  // content written under it is content nobody can find, and the sweep would
  // collect the real bytes as orphans.
  assert.throws(() => contentPath('vocabAudio', { audioPathKey: undefined, occurrenceId: 'o1' }),
    /missing a part/);
  assert.throws(() => contentPath('recording', { sessionId: 'sess1', sentenceId: null }),
    /missing a part/);
  assert.equal(contentPath('recording', { sessionId: 'sess1', sentenceId: 'sent1' }), 'recordings/sess1/sent1.wav');
});
