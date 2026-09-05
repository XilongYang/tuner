import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localeToLang, sliceReferenceClip, resegmentByPunctuation } from '../js/sentence-panel/audio-decode.js';
import { decodeWavPcm16 } from '../js/recorder.js';

// Note: decodeSourceAudio() (the third export of audio-decode.js) is NOT
// tested here -- it calls the browser's AudioContext.decodeAudioData(), a
// real audio codec (mp3/wav/ogg -> PCM). There is no dependency-free way to
// exercise that in Node: the only genuine implementations are either the
// browser itself or a native/WASM codec binding, and the function is a thin
// ~10-line wrapper with essentially no logic of its own to protect -- the
// actual decoding correctness lives entirely in that native code, not here.
// It stays covered by the existing Playwright suite (real Chromium).

test('localeToLang: any locale starting with "ja" (case-insensitive) is Japanese, everything else is English', () => {
  assert.equal(localeToLang('ja-JP'), 'ja');
  assert.equal(localeToLang('JA-jp'), 'ja');
  assert.equal(localeToLang('en-US'), 'en');
  assert.equal(localeToLang(''), 'en');
  assert.equal(localeToLang(null), 'en');
  assert.equal(localeToLang(undefined), 'en');
});

test('sliceReferenceClip: is pure data-in/data-out -- no AudioContext needed, just a channelData array + sampleRate', () => {
  // 1 second of a 440Hz-ish ramp at 16kHz, as a plain Float32Array -- exactly
  // the shape decodeSourceAudio() would hand this function, but built here
  // with no browser API at all.
  const sampleRate = 16000;
  const channelData = new Float32Array(sampleRate);
  for (let i = 0; i < channelData.length; i++) channelData[i] = Math.sin(i / 20) * 0.5;

  const blob = sliceReferenceClip({ channelData, sampleRate }, 100, 200); // [100ms, 300ms)
  assert.equal(blob.type, 'audio/wav');
});

test('sliceReferenceClip: the sliced WAV decodes back to roughly the requested duration', async () => {
  const sampleRate = 16000;
  const channelData = new Float32Array(sampleRate).fill(0.3);
  const blob = sliceReferenceClip({ channelData, sampleRate }, 0, 250); // 250ms
  const buf = await blob.arrayBuffer();
  const { samples, sampleRate: outRate } = decodeWavPcm16(buf);
  assert.equal(outRate, 16000); // encodeWav always resamples to 16kHz
  const expectedSamples = Math.round(0.25 * 16000);
  assert.ok(Math.abs(samples.length - expectedSamples) <= 1);
});

test('sliceReferenceClip: clamps to the buffer bounds rather than reading past the end', () => {
  const sampleRate = 16000;
  const channelData = new Float32Array(1000); // ~62.5ms of audio
  // Ask for a range that runs well past the end of the buffer.
  const blob = sliceReferenceClip({ channelData, sampleRate }, 0, 5000);
  assert.ok(blob); // did not throw
});

test('resegmentByPunctuation: returns [] when there is no usable word-level data', () => {
  assert.deepEqual(resegmentByPunctuation([], 1000), []);
  assert.deepEqual(resegmentByPunctuation([{ locale: 'en-US', words: [] }], 1000), []);
});

test('resegmentByPunctuation: splits one phrase into two sentences at terminal punctuation, with per-sentence audio ranges', () => {
  const phrases = [{
    locale: 'en-US',
    words: [
      { text: 'Hello', offsetMilliseconds: 0, durationMilliseconds: 300 },
      { text: 'world.', offsetMilliseconds: 350, durationMilliseconds: 300 },
      { text: 'Bye', offsetMilliseconds: 1000, durationMilliseconds: 200 },
      { text: 'now.', offsetMilliseconds: 1250, durationMilliseconds: 300 },
    ],
  }];
  const parts = resegmentByPunctuation(phrases, 2000);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].text, 'Hello world.');
  assert.equal(parts[1].text, 'Bye now.');
  assert.equal(parts[0].lang, 'en');
  // First sentence's audio starts at/near its first word's own offset (0ms);
  // padding is clamped so it never goes negative.
  assert.ok(parts[0].offsetMilliseconds >= 0);
  assert.ok(parts[0].durationMilliseconds > 0);
  // Second sentence starts after the first ends (no overlap).
  assert.ok(parts[1].offsetMilliseconds >= parts[0].offsetMilliseconds);
});

test('resegmentByPunctuation: tags a sentence built mostly from Japanese words as lang "ja"', () => {
  const phrases = [{
    locale: 'ja-JP',
    words: [
      { text: 'こんにちは', offsetMilliseconds: 0, durationMilliseconds: 300 },
      { text: '。', offsetMilliseconds: 300, durationMilliseconds: 0 },
    ],
  }];
  const parts = resegmentByPunctuation(phrases, 1000);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].lang, 'ja');
});

test('resegmentByPunctuation: pads each side by up to SLICE_PAD_MS but never overlaps the neighboring word', () => {
  // Two words 40ms apart (less than 2*120ms pad) straddling a sentence boundary --
  // the padding on each side must clamp to at most half the gap (20ms) so the
  // two sentences' ranges meet but don't overlap.
  const phrases = [{
    locale: 'en-US',
    words: [
      { text: 'One.', offsetMilliseconds: 0, durationMilliseconds: 100 },
      { text: 'Two.', offsetMilliseconds: 140, durationMilliseconds: 100 },
    ],
  }];
  const parts = resegmentByPunctuation(phrases, 1000);
  assert.equal(parts.length, 2);
  const firstEnd = parts[0].offsetMilliseconds + parts[0].durationMilliseconds;
  assert.ok(firstEnd <= parts[1].offsetMilliseconds + 1e-9);
});
