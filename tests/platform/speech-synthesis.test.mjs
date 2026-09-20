import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserSpeech } from '../../js/platform/speech-synthesis.js';

/**
 * A stand-in for the browser's speech engine.
 *
 * `ending` is how it answers a request to speak: 'start' behaves like a working
 * engine, 'error' like one that fails, and 'silent' like a headless browser --
 * it takes the utterance and never says anything about it again.
 */
function fakeWindow({ ending = 'start', voices = [{ name: 'Test Voice' }] } = {}) {
  const spoken = [];
  let cancels = 0;

  class Utterance {
    constructor(text) {
      this.text = text;
      this.lang = null;
    }
  }

  return {
    spoken,
    cancels: () => cancels,
    SpeechSynthesisUtterance: Utterance,
    speechSynthesis: {
      getVoices: () => voices,
      addEventListener: () => {},
      cancel: () => { cancels += 1; },
      speak: (utterance) => {
        spoken.push({ text: utterance.text, lang: utterance.lang });
        if (ending === 'start') utterance.onstart();
        if (ending === 'end-only') utterance.onend();
        if (ending === 'error') utterance.onerror();
      },
    },
  };
}

test('available: needs the API and at least one voice', () => {
  assert.equal(browserSpeech(fakeWindow()).available(), true);
  assert.equal(browserSpeech({}).available(), false);
  assert.equal(browserSpeech({ speechSynthesis: { getVoices: () => [] } }).available(), false, 'no utterance constructor');
});

test('available: an engine with no voices cannot speak, whatever it claims', () => {
  // A headless browser exposes the API, has no voices, and then neither speaks
  // nor reports an error. Offering it would leave a sentence "preparing" for
  // ever, so it counts as unavailable and the missing key is reported instead.
  assert.equal(browserSpeech(fakeWindow({ voices: [] })).available(), false);
});

test('available: an engine that throws when asked is unavailable, not an exception', () => {
  const win = fakeWindow();
  win.speechSynthesis.getVoices = () => { throw new Error('refused'); };
  assert.equal(browserSpeech(win).available(), false);
});

test('speak: says the text in the locale asked for, and resolves once it has started', async () => {
  const win = fakeWindow();
  await browserSpeech(win).speak('おはよう', 'ja-JP');
  assert.deepEqual(win.spoken, [{ text: 'おはよう', lang: 'ja-JP' }]);
});

test('speak: a reading that ends without ever starting still settles', async () => {
  const win = fakeWindow({ ending: 'end-only' });
  await browserSpeech(win).speak('short', 'en-US');
  assert.deepEqual(win.spoken, [{ text: 'short', lang: 'en-US' }]);
});

test('speak: cancels whatever was being said first -- two readings at once is never wanted', async () => {
  const win = fakeWindow();
  const speech = browserSpeech(win);
  await speech.speak('one', 'en-US');
  await speech.speak('two', 'en-US');
  assert.equal(win.cancels(), 2);
});

test('speak: an engine failure rejects with something sayable, not a DOM event', async () => {
  const speech = browserSpeech(fakeWindow({ ending: 'error' }));
  await assert.rejects(speech.speak('x', 'en-US'), /built-in voice failed/);
});

test('speak: an engine that never starts is given up on rather than waited on for ever', async () => {
  // What a headless browser does with an utterance: takes it, says nothing.
  const win = fakeWindow({ ending: 'silent' });
  const speech = browserSpeech(win, { startTimeoutMs: 10 });

  await assert.rejects(speech.speak('x', 'en-US'), /did not respond/);
  assert.equal(win.cancels(), 2, 'and it is told to stop, in case it was about to');
});

test('speak: with no engine at all it rejects rather than throwing synchronously', async () => {
  await assert.rejects(browserSpeech({}).speak('x', 'en-US'), /no built-in voice/);
});

test('cancel: stops what is being said, and is safe when nothing is', async () => {
  const win = fakeWindow({ ending: 'silent' });
  const speech = browserSpeech(win, { startTimeoutMs: 10 });

  // The reading is abandoned, so its promise settles as a rejection; claiming
  // it here is what keeps that from surfacing as an unhandled one.
  const reading = assert.rejects(speech.speak('long sentence', 'en-US'), /did not respond/);
  speech.cancel();
  assert.equal(win.cancels(), 2, 'once before speaking, once to stop');
  await reading;

  browserSpeech({}).cancel();
});
