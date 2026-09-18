import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  entity, f, hashKey, toNode, fromNode, walkContent, presentContent,
  SESSION, SENTENCE, VOCAB_ENTRY, FOLDER,
} from '../../js/model/schema.js';
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
  const a = toNode(FOLDER, { id: 1, name: 'A', parentId: null, createdAt: 1, updatedAt: 2 });
  const b = toNode(FOLDER, { updatedAt: 2, createdAt: 1, parentId: null, name: 'A', id: 1 });
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
    id: 'sess', name: 'S', folderId: null, splitMode: 'audio', createdAt: 1, updatedAt: 5, metaUpdatedAt: 4,
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

test('presentContent: keeps only slots that actually hold content', () => {
  const session = {
    id: 'sess1', inputTextHash: 'ih', sourceAudioHash: null,
    sentences: [{ id: 'sent1', recordingHash: null, referenceHash: 'fh', assessmentHash: null }],
  };
  assert.deepEqual(presentContent(SESSION, session).map((s) => s.kind), ['inputText', 'reference']);
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
