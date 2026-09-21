import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitAtPointer, mergeSelected } from '../../js/app/commands/split.js';
import { createSessionStore } from '../../js/app/store.js';
import { blankSentence, updateSentence } from '../../js/model/session.js';

const sentence = (id, text, over = {}) => blankSentence({ id, text, lang: 'en', now: 1, ...over });

const session = (sentences, over = {}) => ({
  id: 'sess1', name: null, folderId: null, splitMode: 'auto',
  createdAt: 1, updatedAt: 1, metaUpdatedAt: 1,
  inputText: null, inputTextHash: null, sourceAudio: null, sourceAudioHash: null,
  sentences, ...over,
});

/** An imported sentence: reference audio sliced from the session's source file. */
const imported = (id, text, offsetMs, durationMs) => sentence(id, text, {
  referenceSource: 'import', sourceOffsetMs: offsetMs, sourceDurationMs: durationMs,
  reference: `clip:${id}`, referenceHash: `h:${id}`,
});

function deps(over = {}) {
  let n = 0;
  const tombstoned = [];
  return {
    tombstoned,
    decodeCalls: () => decoded,
    deps: {
      ids: () => `new-${++n}`,
      clock: () => 1000,
      tombstone: async (idsToKill) => { tombstoned.push(...idsToKill); },
      hash: { hashBlob: async (blob) => `hash(${blob})`, materializeBlob: async (blob) => blob },
      audio: {
        decode: async () => { decoded++; return { channelData: new Float32Array(16_000), sampleRate: 16_000 }; },
        cutClip: (_decoded, range) => `cut:${range.offsetMs}+${range.durationMs}`,
      },
      ...over,
    },
  };
}
let decoded = 0;

test('split: divides the text and records what replaced what', async () => {
  const store = createSessionStore(session([sentence('a', 'Alpha beta')]));
  const d = deps();

  const outcome = await splitAtPointer({ store, sentenceId: 'a', charIndex: 6, ms: null, deps: d.deps });

  assert.equal(outcome.ok, true);
  assert.deepEqual(store.get().sentences.map((s) => s.text), ['Alpha ', 'beta']);
  assert.deepEqual(d.tombstoned, ['a'], 'the replaced sentence is tombstoned so it cannot come back');
});

test('split: cuts both halves of the reference audio from the source file', async () => {
  const store = createSessionStore(session(
    [imported('a', 'Alpha beta', 1000, 800)],
    { splitMode: 'audio', sourceAudio: 'SOURCE_FILE' },
  ));

  const outcome = await splitAtPointer({ store, sentenceId: 'a', charIndex: 6, ms: 1300, deps: deps().deps });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.audioFollowed, true);
  const [left, right] = store.get().sentences;
  assert.equal(left.reference, 'cut:1000+300');
  assert.equal(right.reference, 'cut:1300+500');
  assert.equal(left.referenceHash, 'hash(cut:1000+300)');
  assert.deepEqual([left.sourceOffsetMs, left.sourceDurationMs], [1000, 300]);
  assert.deepEqual([right.sourceOffsetMs, right.sourceDurationMs], [1300, 500]);
});

test('split: a position with no timestamp splits the text and says the audio could not follow', async () => {
  // The case that used to arrive as Number('') === 0 and silently produce two
  // empty clips. Now it is reported, and neither half claims audio it lacks.
  const store = createSessionStore(session(
    [imported('a', 'Alpha beta', 1000, 800)],
    { splitMode: 'audio', sourceAudio: 'SOURCE_FILE' },
  ));

  const outcome = await splitAtPointer({ store, sentenceId: 'a', charIndex: 6, ms: null, deps: deps().deps });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.audioFollowed, false, 'the caller can say so');
  for (const half of store.get().sentences) {
    assert.equal(half.reference, null);
    assert.equal(half.referenceHash, null, 'no hash claiming a clip that was never made');
    assert.equal(half.sourceOffsetMs, null);
  }
});

test('split: a timestamp of 0 is honoured rather than treated as missing', async () => {
  const store = createSessionStore(session(
    [imported('a', 'Alpha beta', -200, 800)],
    { splitMode: 'audio', sourceAudio: 'SOURCE_FILE' },
  ));

  const outcome = await splitAtPointer({ store, sentenceId: 'a', charIndex: 6, ms: 0, deps: deps().deps });
  assert.equal(outcome.audioFollowed, true);
  assert.equal(store.get().sentences[0].reference, 'cut:-200+200');
});

test('split: a text session never claims the audio failed -- it had none to begin with', async () => {
  const store = createSessionStore(session([sentence('a', 'Alpha beta')]));
  const outcome = await splitAtPointer({ store, sentenceId: 'a', charIndex: 6, ms: null, deps: deps().deps });
  assert.equal(outcome.audioFollowed, null);
});

test('split: an undecodable source still splits the text', async () => {
  const store = createSessionStore(session(
    [imported('a', 'Alpha beta', 1000, 800)],
    { splitMode: 'audio', sourceAudio: 'CORRUPT' },
  ));
  const d = deps({ audio: { decode: async () => { throw new Error('bad file'); }, cutClip: () => 'never' } });

  const outcome = await splitAtPointer({ store, sentenceId: 'a', charIndex: 6, ms: 1300, deps: d.deps });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.audioFollowed, false);
  assert.deepEqual(store.get().sentences.map((s) => s.text), ['Alpha ', 'beta']);
});

test('split: a change landing during the audio cut supersedes the split, which is dropped', async () => {
  // The bug this ordering exists for: an index captured before a
  // several-hundred-millisecond decode, applied after the list moved.
  const store = createSessionStore(session(
    [imported('a', 'Alpha beta', 1000, 800), sentence('b', 'second')],
    { splitMode: 'audio', sourceAudio: 'SOURCE_FILE' },
  ));

  const d = deps({
    audio: {
      decode: async () => {
        // A sync arrives, or the user edits, while the decode is in flight.
        store.apply((s) => updateSentence(s, 'b', { hidden: true }, 500), 'sync');
        return { channelData: new Float32Array(16_000), sampleRate: 16_000 };
      },
      cutClip: (_d, range) => `cut:${range.offsetMs}`,
    },
  });

  const outcome = await splitAtPointer({ store, sentenceId: 'a', charIndex: 6, ms: 1300, deps: d.deps });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'superseded');
  assert.deepEqual(store.get().sentences.map((s) => s.id), ['a', 'b'], 'the list is untouched');
  assert.equal(store.get().sentences[1].hidden, true, 'and the change that won survived');
  assert.deepEqual(d.tombstoned, [], 'nothing was tombstoned for a split that did not happen');
});

test('split: a refused cut is distinguished from being superseded', async () => {
  const store = createSessionStore(session([sentence('a', ' beta')]));
  const outcome = await splitAtPointer({ store, sentenceId: 'a', charIndex: 1, ms: null, deps: deps().deps });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'refused');
});

test('split: a sentence that is already gone is reported, not mis-targeted', async () => {
  const store = createSessionStore(session([sentence('a', 'one')]));
  const outcome = await splitAtPointer({ store, sentenceId: 'vanished', charIndex: 1, ms: null, deps: deps().deps });
  assert.equal(outcome.reason, 'gone');
});

test('split: with no session at all it refuses cleanly', async () => {
  const outcome = await splitAtPointer({ store: createSessionStore(), sentenceId: 'a', charIndex: 1, ms: null, deps: deps().deps });
  assert.equal(outcome.reason, 'no-session');
});

test('merge: joins adjacent sentences and tombstones every part', async () => {
  const store = createSessionStore(session([sentence('a', 'Alpha '), sentence('b', 'beta'), sentence('c', 'rest')]));
  const d = deps();

  const outcome = await mergeSelected({ store, sentenceIds: ['a', 'b'], deps: d.deps });

  assert.equal(outcome.ok, true);
  assert.deepEqual(store.get().sentences.map((s) => s.text), ['Alpha beta', 'rest']);
  assert.deepEqual(d.tombstoned.sort(), ['a', 'b']);
});

test('merge: the clip is cut fresh from the source over the whole span', async () => {
  // Cutting fresh rather than joining the existing clips is what stops repeated
  // splits and merges from compounding resampling error.
  const store = createSessionStore(session(
    [imported('a', 'Alpha ', 1000, 300), imported('b', 'beta', 1300, 500)],
    { splitMode: 'audio', sourceAudio: 'SOURCE_FILE' },
  ));

  const outcome = await mergeSelected({ store, sentenceIds: ['a', 'b'], deps: deps().deps });

  assert.equal(outcome.audioFollowed, true);
  const merged = store.get().sentences[0];
  assert.equal(merged.reference, 'cut:1000+800');
  assert.deepEqual([merged.sourceOffsetMs, merged.sourceDurationMs], [1000, 800]);
});

test('merge: a run where one part has no range keeps no audio, and says so', async () => {
  const store = createSessionStore(session(
    [imported('a', 'Alpha ', 1000, 300), sentence('b', 'beta', { referenceSource: 'import' })],
    { splitMode: 'audio', sourceAudio: 'SOURCE_FILE' },
  ));

  const outcome = await mergeSelected({ store, sentenceIds: ['a', 'b'], deps: deps().deps });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.audioFollowed, false);
  assert.equal(store.get().sentences[0].reference, null);
});

test('merge: non-adjacent sentences are refused before any work is done', async () => {
  const store = createSessionStore(session([sentence('a', 'one'), sentence('b', 'two'), sentence('c', 'three')]));
  const before = decoded;

  const outcome = await mergeSelected({ store, sentenceIds: ['a', 'c'], deps: deps().deps });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'not-adjacent');
  assert.equal(decoded, before, 'no audio was decoded for a merge that cannot happen');
});

test('merge: a change landing during the cut supersedes it', async () => {
  const store = createSessionStore(session(
    [imported('a', 'Alpha ', 1000, 300), imported('b', 'beta', 1300, 500)],
    { splitMode: 'audio', sourceAudio: 'SOURCE_FILE' },
  ));

  const d = deps({
    audio: {
      decode: async () => {
        store.replace(session([sentence('x', 'replaced by a sync')]), 'sync');
        return { channelData: new Float32Array(16), sampleRate: 16_000 };
      },
      cutClip: () => 'cut',
    },
  });

  const outcome = await mergeSelected({ store, sentenceIds: ['a', 'b'], deps: d.deps });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'superseded');
  assert.deepEqual(store.get().sentences.map((s) => s.id), ['x']);
  assert.deepEqual(d.tombstoned, []);
});

test('split then merge restores the original text and range exactly', async () => {
  const store = createSessionStore(session(
    [imported('a', 'Alpha beta', 1000, 800)],
    { splitMode: 'audio', sourceAudio: 'SOURCE_FILE' },
  ));

  await splitAtPointer({ store, sentenceId: 'a', charIndex: 6, ms: 1300, deps: deps().deps });
  const halves = store.get().sentences.map((s) => s.id);
  await mergeSelected({ store, sentenceIds: halves, deps: deps().deps });

  const merged = store.get().sentences[0];
  assert.equal(merged.text, 'Alpha beta');
  assert.deepEqual([merged.sourceOffsetMs, merged.sourceDurationMs], [1000, 800]);
});
