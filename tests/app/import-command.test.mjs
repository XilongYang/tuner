import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importAudio } from '../../js/app/commands/import-audio.js';
import { createSessionStore } from '../../js/app/store.js';

const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });

const phrase = (lang, words, over = {}) => ({
  lang,
  text: words.map((w) => w.text).join(lang === 'ja' ? '' : ' '),
  offsetMs: words[0]?.offsetMs ?? 0,
  durationMs: 1000,
  words,
  ...over,
});
const word = (text, offsetMs, durationMs) => ({ text, offsetMs, durationMs });

function harness({
  phrases = [phrase('en', [word('Hello', 0, 400), word('there.', 500, 400), word('How', 1500, 300), word('are', 1900, 200), word('you?', 2200, 400)])],
  durationMs = 3000,
  credentials = true,
  resourceName = 'my-resource',
  transcribeFails = null,
  decodeFails = false,
  cutReturns = undefined,
} = {}) {
  let n = 0;
  const released = [];
  const progress = [];

  return {
    store: createSessionStore(),
    progress,
    released,
    deps: {
      ids: () => `id-${++n}`,
      clock: () => 1000,
      release: () => released.push('released'),
      autosave: { reset: () => {} },
      hash: { hashBlob: async () => 'source-hash', materializeBlob: async (blob) => blob },
      settings: {
        hasCredentials: () => credentials,
        credentials: () => ({ key: 'k', region: 'r', resourceName }),
      },
      speech: () => ({
        transcribe: async () => {
          if (transcribeFails) throw new Error(transcribeFails);
          return { phrases, durationMs };
        },
      }),
      audio: {
        decode: async () => {
          if (decodeFails) throw new Error('unsupported format');
          return { channelData: new Float32Array(48_000), sampleRate: 16_000 };
        },
        cutClip: cutReturns !== undefined
          ? () => cutReturns
          : (_decoded, range) => `clip:${range.offsetMs}+${Math.round(range.durationMs)}`,
      },
    },
  };
}

test('builds a session of sentences split by punctuation, not by the service\'s phrases', async () => {
  const h = harness();
  const result = await importAudio({ store: h.store, file, deps: h.deps });

  assert.equal(result.ok, true);
  assert.equal(result.fromWordTimings, true);
  assert.deepEqual(h.store.get().sentences.map((s) => s.text), ['Hello there.', 'How are you?']);
});

test('the session keeps the original file, so later cuts come from it', async () => {
  const h = harness();
  await importAudio({ store: h.store, file, deps: h.deps });

  const session = h.store.get();
  assert.equal(session.sourceAudio, file);
  assert.equal(session.sourceAudioHash, 'source-hash');
  assert.equal(session.splitMode, 'audio');
});

test('each sentence gets its own clip and the markers to re-cut it', async () => {
  const h = harness();
  await importAudio({ store: h.store, file, deps: h.deps });

  for (const sentence of h.store.get().sentences) {
    assert.ok(sentence.reference);
    assert.equal(sentence.referenceSource, 'import');
    assert.ok(Number.isFinite(sentence.sourceOffsetMs));
    assert.ok(sentence.sourceDurationMs > 0);
  }
});

test('word positions inside each sentence are kept, so it can be split at real boundaries', async () => {
  const h = harness();
  await importAudio({ store: h.store, file, deps: h.deps });

  const [first] = h.store.get().sentences;
  assert.equal(first.words.length, 2);
  assert.deepEqual(first.words.map((w) => [w.charStart, w.charEnd]), [[0, 5], [6, 12]]);
});

test('the practice text is derived from the sentences, since none was typed', async () => {
  const h = harness();
  await importAudio({ store: h.store, file, deps: h.deps });
  assert.equal(h.store.get().inputText, 'Hello there.\nHow are you?');
});

test('whatever was on screen is released before the import replaces it', async () => {
  const h = harness();
  await importAudio({ store: h.store, file, deps: h.deps });
  assert.deepEqual(h.released, ['released']);
});

test('a transcription with no word timings falls back to the service\'s own boundaries', async () => {
  const h = harness({
    phrases: [
      { lang: 'en', text: 'First phrase.', offsetMs: 0, durationMs: 1000, words: [] },
      { lang: 'en', text: 'Second phrase.', offsetMs: 1200, durationMs: 900, words: [] },
    ],
  });

  const result = await importAudio({ store: h.store, file, deps: h.deps });

  assert.equal(result.ok, true);
  assert.equal(result.fromWordTimings, false);
  assert.deepEqual(h.store.get().sentences.map((s) => s.text), ['First phrase.', 'Second phrase.']);
  assert.deepEqual(h.store.get().sentences.map((s) => s.words), [null, null], 'no cut points to offer inside them');
  assert.ok(h.store.get().sentences.every((s) => s.reference), 'but they still have audio');
});

test('a phrase without a range is skipped by the fallback rather than cut wrongly', async () => {
  const h = harness({
    phrases: [
      { lang: 'en', text: 'Usable.', offsetMs: 0, durationMs: 500, words: [] },
      { lang: 'en', text: 'No range.', offsetMs: null, durationMs: null, words: [] },
    ],
  });

  await importAudio({ store: h.store, file, deps: h.deps });
  assert.deepEqual(h.store.get().sentences.map((s) => s.text), ['Usable.']);
});

test('a sentence whose clip could not be cut claims no audio', async () => {
  const h = harness({ cutReturns: null });
  const result = await importAudio({ store: h.store, file, deps: h.deps });

  assert.equal(result.ok, true);
  assert.equal(result.withAudio, 0);
  for (const sentence of h.store.get().sentences) {
    assert.equal(sentence.reference, null);
    assert.equal(sentence.referenceSource, null, 'and is not marked as imported audio');
    assert.equal(sentence.sourceOffsetMs, null);
  }
});

test('Japanese and English are labelled per sentence', async () => {
  const h = harness({
    phrases: [
      phrase('ja', [word('今日は', 0, 400), word('いい', 500, 300), word('天気。', 900, 400)]),
      phrase('en', [word('Nice', 2000, 300), word('weather.', 2400, 500)]),
    ],
  });

  await importAudio({ store: h.store, file, deps: h.deps });
  assert.deepEqual(h.store.get().sentences.map((s) => s.lang), ['ja', 'en']);
});

test('progress is reported at each stage, because this takes a while', async () => {
  const h = harness();
  await importAudio({ store: h.store, file, deps: h.deps, onProgress: (p) => h.progress.push(p) });

  const stages = [...new Set(h.progress.map((p) => p.stage))];
  assert.deepEqual(stages, ['transcribing', 'segmenting', 'decoding', 'cutting']);
  assert.deepEqual(h.progress.filter((p) => p.done).map((p) => p.done), [1, 2]);
});

test('without credentials, or without a resource name, it says which', async () => {
  assert.deepEqual(await importAudio({ store: createSessionStore(), file, deps: harness({ credentials: false }).deps }),
    { ok: false, reason: 'no-credentials' });
  assert.deepEqual(await importAudio({ store: createSessionStore(), file, deps: harness({ resourceName: '' }).deps }),
    { ok: false, reason: 'no-resource-name' });
});

test('a transcription failure is reported with its message, and the screen is untouched', async () => {
  const h = harness({ transcribeFails: 'HTTP 413 — file too large' });
  const result = await importAudio({ store: h.store, file, deps: h.deps });

  assert.equal(result.ok, false);
  assert.match(result.reason, /413/);
  assert.equal(h.store.get(), null);
  assert.deepEqual(h.released, [], 'nothing was discarded for an import that did not happen');
});

test('a file with no speech in it is reported as such', async () => {
  const h = harness({ phrases: [] });
  assert.deepEqual(await importAudio({ store: h.store, file, deps: h.deps }), { ok: false, reason: 'no-speech' });
});

test('an undecodable file is reported, and nothing is put on screen', async () => {
  const h = harness({ decodeFails: true });
  const result = await importAudio({ store: h.store, file, deps: h.deps });

  assert.equal(result.ok, false);
  assert.match(result.reason, /could not decode/);
  assert.equal(h.store.get(), null);
});

test('the clips cut cover the ranges the segmentation produced', async () => {
  const h = harness();
  await importAudio({ store: h.store, file, deps: h.deps });

  const [first, second] = h.store.get().sentences;
  assert.match(first.reference, /^clip:/);
  assert.equal(first.reference, `clip:${first.sourceOffsetMs}+${Math.round(first.sourceDurationMs)}`);
  assert.ok(second.sourceOffsetMs > first.sourceOffsetMs);
});
