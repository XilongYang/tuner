import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  speak, startRecording, stopRecording, score, toggleHidden, setLanguage,
} from '../../js/app/commands/practice.js';
import { createSessionStore } from '../../js/app/store.js';
import { blankSentence, updateSentence } from '../../js/model/session.js';

const clip = (bytes) => new Blob([new Uint8Array(bytes)], { type: 'audio/wav' });

const session = (sentences, over = {}) => ({
  id: 'sess1', name: null, folderId: null, splitMode: 'auto',
  createdAt: 1, updatedAt: 1, metaUpdatedAt: 1,
  inputText: null, inputTextHash: null, sourceAudio: null, sourceAudioHash: null,
  sentences, ...over,
});

const sentence = (id, text, over = {}) => blankSentence({ id, text, lang: 'en', now: 1, ...over });

function harness({
  sentences = [sentence('s1', 'Hello there.')],
  credentials = true,
  speechOver = {},
  browser = { available: true },
} = {}) {
  const played = [];
  const calls = [];
  const spoken = [];

  const speechClient = {
    synthesize: async (text, locale, voice) => { calls.push({ op: 'synthesize', text, locale, voice }); return clip([1]); },
    assess: async (blob, referenceText, locale) => {
      calls.push({ op: 'assess', referenceText, locale });
      return { overall: { pronunciation: 90 }, words: [] };
    },
    ...speechOver,
  };

  return {
    store: createSessionStore(session(sentences)),
    calls,
    played,
    deps: {
      clock: () => 1000,
      speech: () => speechClient,
      settings: {
        hasCredentials: () => credentials,
        voice: (locale) => `voice-for-${locale}`,
      },
      player: {
        play: async (blob, token) => { played.push(token); return true; },
        stop: () => played.push('stop'),
      },
      browserSpeech: {
        available: () => browser.available,
        speak: async (text, locale) => {
          spoken.push({ text, locale });
          if (browser.fails) throw new Error('The browser\'s built-in voice failed.');
        },
        cancel: () => spoken.push('cancel'),
      },
    },
    spoken,
  };
}

const fakeRecorder = (over = {}) => ({
  start: async () => true,
  stop: async () => ({ blob: clip([9]), durationMs: 1500 }),
  ...over,
});

test('speak: synthesizes a reference and plays it', async () => {
  const h = harness();
  const result = await speak({ store: h.store, sentenceId: 's1', deps: h.deps });

  assert.equal(result.ok, true);
  assert.equal(result.synthesized, true);
  assert.equal(h.calls[0].locale, 'en-US');
  assert.equal(h.calls[0].voice, 'voice-for-en-US');
  assert.ok(h.store.get().sentences[0].reference);
  assert.deepEqual(h.played, ['s1']);
});

test('speak: an existing reference is played rather than synthesized again', async () => {
  const h = harness({ sentences: [sentence('s1', 'Hi', { reference: clip([5]), referenceSource: 'tts' })] });
  const result = await speak({ store: h.store, sentenceId: 's1', deps: h.deps });

  assert.equal(result.synthesized, false);
  assert.deepEqual(h.calls, [], 'no request was made');
});

test('speak: an imported reference is never replaced by synthesis', async () => {
  // It is a recording of the real thing; an imitation would be a downgrade.
  const h = harness({ sentences: [sentence('s1', 'Hi', { referenceSource: 'import', reference: null })] });
  const result = await speak({ store: h.store, sentenceId: 's1', deps: h.deps });

  assert.deepEqual(result, { ok: false, reason: 'no-reference-audio' });
  assert.deepEqual(h.calls, []);
});

test('speak: force re-synthesizes even over an existing clip', async () => {
  const h = harness({ sentences: [sentence('s1', 'Hi', { reference: clip([5]), referenceSource: 'tts' })] });
  const result = await speak({ store: h.store, sentenceId: 's1', deps: h.deps, force: true });

  assert.equal(result.synthesized, true);
  assert.equal(h.calls.length, 1);
});

test('speak: the stale hash is cleared, so the record never claims the old clip', async () => {
  const h = harness({ sentences: [sentence('s1', 'Hi', { referenceHash: 'hash-of-old-clip' })] });
  await speak({ store: h.store, sentenceId: 's1', deps: h.deps });
  assert.equal(h.store.get().sentences[0].referenceHash, null);
});

test('speak: without credentials the browser reads it, and says which voice that was', async () => {
  const h = harness({ credentials: false });

  const result = await speak({ store: h.store, sentenceId: 's1', deps: h.deps });

  assert.equal(result.ok, true);
  assert.equal(result.viaBrowser, true);
  assert.match(result.message, /browser's own voice/);
  assert.deepEqual(h.spoken, [{ text: 'Hello there.', locale: 'en-US' }]);
  assert.deepEqual(h.calls, [], 'the service was not called');
});

test('speak: the browser reading leaves no clip on the sentence -- there is nothing to keep', async () => {
  const h = harness({ credentials: false });
  await speak({ store: h.store, sentenceId: 's1', deps: h.deps });

  const [only] = h.store.get().sentences;
  assert.equal(only.reference, null, 'nothing to store, nothing to hash, nothing to sync');
  assert.equal(only.referenceHash, null);
  assert.equal(only.referenceSource, null);
});

test('speak: a browser that cannot speak at all still reports the missing key', async () => {
  const h = harness({ credentials: false, browser: { available: false } });
  assert.deepEqual(await speak({ store: h.store, sentenceId: 's1', deps: h.deps }), { ok: false, reason: 'no-credentials' });
});

test('speak: a service failure is reported with its message', async () => {
  const h = harness({ speechOver: { synthesize: async () => { throw new Error('HTTP 429'); } } });
  const result = await speak({ store: h.store, sentenceId: 's1', deps: h.deps });
  assert.match(result.reason, /429/);
});

test('speak: a sentence that is gone is reported, not synthesized for', async () => {
  const h = harness();
  assert.deepEqual(await speak({ store: h.store, sentenceId: 'vanished', deps: h.deps }), { ok: false, reason: 'gone' });
});

test('startRecording: stops playback first, so the microphone does not capture it', async () => {
  const h = harness();
  const result = await startRecording({ store: h.store, sentenceId: 's1', recorder: fakeRecorder(), deps: h.deps });

  assert.equal(result.ok, true);
  assert.deepEqual(h.played, ['stop']);
});

test('startRecording: a recorder that refuses (already running) is reported', async () => {
  const h = harness();
  const result = await startRecording({ store: h.store, sentenceId: 's1', recorder: fakeRecorder({ start: async () => false }), deps: h.deps });
  assert.deepEqual(result, { ok: false, reason: 'already-recording' });
});

test('startRecording: a denied microphone surfaces its message', async () => {
  const h = harness();
  const recorder = fakeRecorder({ start: async () => { throw new Error('Microphone permission denied.'); } });
  const result = await startRecording({ store: h.store, sentenceId: 's1', recorder, deps: h.deps });
  assert.match(result.reason, /permission denied/);
});

test('stopRecording: keeps the take on the sentence', async () => {
  const h = harness();
  const result = await stopRecording({ store: h.store, sentenceId: 's1', recorder: fakeRecorder(), deps: h.deps });

  assert.equal(result.ok, true);
  assert.equal(result.durationMs, 1500);
  assert.ok(h.store.get().sentences[0].recording);
});

test('stopRecording: a new take clears the score of the previous one', async () => {
  // Otherwise the screen shows a number describing audio nobody can play.
  const h = harness({ sentences: [sentence('s1', 'Hi', { recording: clip([1]), assessment: { overall: { pronunciation: 50 } }, assessmentHash: 'old' })] });

  await stopRecording({ store: h.store, sentenceId: 's1', recorder: fakeRecorder(), deps: h.deps });

  assert.equal(h.store.get().sentences[0].assessment, null);
  assert.equal(h.store.get().sentences[0].assessmentHash, null);
});

test('stopRecording: a take for a sentence that is gone is handed back, not attached elsewhere', async () => {
  const h = harness();
  h.store.replace(session([sentence('replacement', 'different text')]));

  const result = await stopRecording({ store: h.store, sentenceId: 's1', recorder: fakeRecorder(), deps: h.deps });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'gone');
  assert.ok(result.discarded.blob, 'the caller can still offer it');
  assert.equal(h.store.get().sentences[0].recording, null, 'and nothing was attached to the wrong sentence');
});

test('stopRecording: with nothing recording it says so', async () => {
  const h = harness();
  const result = await stopRecording({ store: h.store, sentenceId: 's1', recorder: fakeRecorder({ stop: async () => null }), deps: h.deps });
  assert.deepEqual(result, { ok: false, reason: 'not-recording' });
});

test('score: assesses the take against the sentence text', async () => {
  const h = harness({ sentences: [sentence('s1', 'Hello there.', { recording: clip([1]) })] });
  const result = await score({ store: h.store, sentenceId: 's1', deps: h.deps });

  assert.equal(result.ok, true);
  assert.equal(h.calls[0].referenceText, 'Hello there.');
  assert.equal(h.calls[0].locale, 'en-US');
  assert.equal(h.store.get().sentences[0].assessment.overall.pronunciation, 90);
});

test('score: without a recording there is nothing to score', async () => {
  const h = harness();
  assert.deepEqual(await score({ store: h.store, sentenceId: 's1', deps: h.deps }), { ok: false, reason: 'no-recording' });
});

test('score: a result for text that has since been edited is discarded', async () => {
  // A score describes the text it was scored against; showing it beside
  // different text is worse than showing none.
  const h = harness({ sentences: [sentence('s1', 'Hello there.', { recording: clip([1]) })] });
  const deps = {
    ...h.deps,
    speech: () => ({
      assess: async () => {
        h.store.apply((s) => updateSentence(s, 's1', { text: 'Edited while scoring' }, 500));
        return { overall: { pronunciation: 90 }, words: [] };
      },
    }),
  };

  const result = await score({ store: h.store, sentenceId: 's1', deps });

  assert.deepEqual(result, { ok: false, reason: 'superseded' });
  assert.equal(h.store.get().sentences[0].assessment, null);
});

test('score: a result for a take that has since been re-recorded is discarded', async () => {
  const h = harness({ sentences: [sentence('s1', 'Hello there.', { recording: clip([1]) })] });
  const deps = {
    ...h.deps,
    speech: () => ({
      assess: async () => {
        h.store.apply((s) => updateSentence(s, 's1', { recording: clip([2]) }, 500));
        return { overall: { pronunciation: 90 }, words: [] };
      },
    }),
  };

  assert.equal((await score({ store: h.store, sentenceId: 's1', deps })).reason, 'superseded');
  assert.equal(h.store.get().sentences[0].assessment, null);
});

test('score: a sentence removed while scoring is reported as gone, not superseded', async () => {
  const h = harness({ sentences: [sentence('s1', 'Hello there.', { recording: clip([1]) })] });
  const deps = {
    ...h.deps,
    speech: () => ({
      assess: async () => {
        h.store.replace(session([sentence('other', 'x')]));
        return { overall: {}, words: [] };
      },
    }),
  };

  assert.equal((await score({ store: h.store, sentenceId: 's1', deps })).reason, 'gone');
});

test('toggleHidden: hides and reveals', () => {
  const h = harness();
  toggleHidden({ store: h.store, sentenceId: 's1', hidden: true, deps: h.deps });
  assert.equal(h.store.get().sentences[0].hidden, true);
  toggleHidden({ store: h.store, sentenceId: 's1', hidden: false, deps: h.deps });
  assert.equal(h.store.get().sentences[0].hidden, false);
});

test('setLanguage: drops a synthesized reference, which is in the old language', () => {
  const h = harness({ sentences: [sentence('s1', 'Hi', { reference: clip([1]), referenceHash: 'h', referenceSource: 'tts', words: [{ charStart: 0, charEnd: 2, offsetMs: 0, durationMs: 10 }] })] });

  setLanguage({ store: h.store, sentenceId: 's1', lang: 'ja', deps: h.deps });

  const after = h.store.get().sentences[0];
  assert.equal(after.lang, 'ja');
  assert.equal(after.reference, null);
  assert.equal(after.referenceHash, null);
  assert.equal(after.words, null, 'timings of the old reading go with it');
});

test('setLanguage: an imported reference is real audio and survives', () => {
  const h = harness({ sentences: [sentence('s1', 'Hi', { reference: clip([1]), referenceSource: 'import', sourceOffsetMs: 0, sourceDurationMs: 100 })] });

  setLanguage({ store: h.store, sentenceId: 's1', lang: 'ja', deps: h.deps });

  const after = h.store.get().sentences[0];
  assert.ok(after.reference);
  assert.equal(after.referenceSource, 'import');
});

test('setLanguage: setting the language it already has changes nothing', () => {
  const h = harness();
  assert.deepEqual(setLanguage({ store: h.store, sentenceId: 's1', lang: 'en', deps: h.deps }), { ok: false });
});

test('speak: a browser voice that fails is reported, not swallowed', async () => {
  const h = harness({ credentials: false, browser: { available: true, fails: true } });
  const result = await speak({ store: h.store, sentenceId: 's1', deps: h.deps });
  assert.equal(result.ok, false);
  assert.match(result.reason, /built-in voice failed/);
});

test('speak: the browser voice stops any clip that was playing -- one sound at a time', async () => {
  const h = harness({ credentials: false });
  await speak({ store: h.store, sentenceId: 's1', deps: h.deps });
  assert.deepEqual(h.played, ['stop']);
});

test('speak: a stored clip is still preferred over the browser voice', async () => {
  const h = harness({
    credentials: false,
    sentences: [sentence('s1', 'Hello there.', { reference: clip([7]), referenceSource: 'tts' })],
  });

  const result = await speak({ store: h.store, sentenceId: 's1', deps: h.deps });

  assert.deepEqual(result, { ok: true, synthesized: false, played: true });
  assert.deepEqual(h.spoken, [], 'nothing was read aloud: the recording of it exists');
});
