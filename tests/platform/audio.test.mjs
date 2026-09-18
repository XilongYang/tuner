// Everything here except decode() is arithmetic, so it is tested directly with
// no browser: the WAV header byte by byte, the resampler, the normaliser, and
// the clip cutter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TARGET_RATE, resampleTo16k, normalize, encodeWav, encodeWavBlob, sliceSamples, cutClip,
} from '../../js/platform/audio.js';

const ramp = (length, value = (i) => i / length) => Float32Array.from({ length }, (_, i) => value(i));
const ascii = (view, offset, length) => String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)));

test('resampleTo16k: samples already at the target rate are returned untouched', () => {
  const input = ramp(10);
  assert.equal(resampleTo16k(input, TARGET_RATE), input);
});

test('resampleTo16k: downsampling averages each window rather than picking one sample', () => {
  // 32 kHz -> 16 kHz halves the length, and each output is the mean of a pair.
  const out = resampleTo16k(Float32Array.from([0, 1, 0, 1, 0, 1]), 32_000);
  assert.equal(out.length, 3);
  for (const value of out) assert.equal(value, 0.5);
});

test('resampleTo16k: averaging suppresses an alternating signal that decimation would alias', () => {
  // Nyquist-rate alternation: picking every other sample yields a constant DC
  // offset (the aliasing artefact); averaging yields the true mean instead.
  const alternating = Float32Array.from({ length: 64 }, (_, i) => (i % 2 ? 1 : -1));
  const out = resampleTo16k(alternating, 32_000);
  for (const value of out) assert.equal(value, 0);
});

test('resampleTo16k: upsampling interpolates between neighbours', () => {
  const out = resampleTo16k(Float32Array.from([0, 1]), 8000);
  assert.equal(out.length, 4);
  assert.ok(out[1] > 0 && out[1] < 1, 'an interpolated value sits between its neighbours');
});

test('normalize: scales the loudest sample to the target peak', () => {
  const out = normalize(Float32Array.from([0.1, -0.2, 0.05]));
  assert.ok(Math.abs(Math.min(...out) + 0.95) < 1e-6, 'the loudest sample reaches the target');
});

test('normalize: does NOT modify its input -- every later slice reads the original', () => {
  const input = Float32Array.from([0.1, -0.2]);
  const copy = Float32Array.from(input);
  normalize(input);
  assert.deepEqual([...input], [...copy]);
});

test('normalize: gain is capped so near-silence is not amplified into noise', () => {
  // Tolerance, not equality: Float32Array cannot hold 0.001 exactly, so the
  // product carries the stored value's error.
  const out = normalize(Float32Array.from([0.001]), 0.95, 30);
  assert.ok(Math.abs(out[0] - 0.03) < 1e-6, `capped at 30x gain, got ${out[0]}`);
  assert.ok(out[0] < 0.95, 'not lifted all the way to the target peak');
});

test('normalize: silence stays silent instead of dividing by zero', () => {
  assert.deepEqual([...normalize(new Float32Array(4))], [0, 0, 0, 0]);
});

test('encodeWav: writes a well-formed 16 kHz mono 16-bit header', () => {
  const buffer = encodeWav(ramp(100), TARGET_RATE);
  const view = new DataView(buffer);

  assert.equal(ascii(view, 0, 4), 'RIFF');
  assert.equal(ascii(view, 8, 4), 'WAVE');
  assert.equal(ascii(view, 12, 4), 'fmt ');
  assert.equal(view.getUint32(16, true), 16, 'fmt chunk length');
  assert.equal(view.getUint16(20, true), 1, 'uncompressed PCM');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), TARGET_RATE);
  assert.equal(view.getUint32(28, true), TARGET_RATE * 2, 'bytes per second');
  assert.equal(view.getUint16(32, true), 2, 'bytes per frame');
  assert.equal(view.getUint16(34, true), 16, 'bits per sample');
  assert.equal(ascii(view, 36, 4), 'data');
});

test('encodeWav: declared sizes match the actual byte count', () => {
  const samples = 50;
  const buffer = encodeWav(ramp(samples), TARGET_RATE);
  const view = new DataView(buffer);

  assert.equal(buffer.byteLength, 44 + samples * 2);
  assert.equal(view.getUint32(40, true), samples * 2, 'data chunk length');
  assert.equal(view.getUint32(4, true), 36 + samples * 2, 'RIFF chunk length');
});

test('encodeWav: resamples before encoding, so the length reflects the target rate', () => {
  const buffer = encodeWav(ramp(320), 32_000);
  assert.equal((buffer.byteLength - 44) / 2, 160, '32 kHz input halves at 16 kHz');
});

test('encodeWav: a full-scale sample reaches the 16-bit limit without wrapping', () => {
  const view = new DataView(encodeWav(Float32Array.from([1, -1]), TARGET_RATE));
  // normalize brings the peak to 0.95 first, so these are the scaled extremes
  // -- the point is that both stay inside range with the right sign.
  assert.ok(view.getInt16(44, true) > 30_000 && view.getInt16(44, true) <= 32_767);
  assert.ok(view.getInt16(46, true) < -30_000 && view.getInt16(46, true) >= -32_768);
});

test('encodeWav: zero samples still produce a valid, empty WAV', () => {
  const buffer = encodeWav(new Float32Array(0), TARGET_RATE);
  assert.equal(buffer.byteLength, 44);
  assert.equal(new DataView(buffer).getUint32(40, true), 0);
});

test('encodeWavBlob: is typed audio/wav so playback and scoring both accept it', async () => {
  const blob = encodeWavBlob(ramp(10), TARGET_RATE);
  assert.equal(blob.type, 'audio/wav');
  assert.equal(blob.size, 44 + 10 * 2);
});

const decoded = { channelData: ramp(16_000, (i) => i / 16_000), sampleRate: 16_000 };

test('sliceSamples: converts a millisecond range into the right sample window', () => {
  assert.equal(sliceSamples(decoded, 0, 1000).length, 16_000);
  assert.equal(sliceSamples(decoded, 500, 250).length, 4000);
});

test('sliceSamples: clamps a range that runs past either end', () => {
  assert.equal(sliceSamples(decoded, -500, 1000).length, 8000, 'clamped at the start');
  assert.equal(sliceSamples(decoded, 900, 1000).length, 1600, 'clamped at the end');
  assert.equal(sliceSamples(decoded, 5000, 100).length, 0, 'entirely past the end');
});

test('sliceSamples: copies, so cutting one clip cannot disturb another', () => {
  const source = { channelData: Float32Array.from([0.1, 0.2, 0.3, 0.4]), sampleRate: 4 };
  const before = [...source.channelData];
  const slice = sliceSamples(source, 0, 500);
  slice[0] = 99;
  assert.deepEqual([...source.channelData], before);
});

test('cutClip: produces a WAV of the requested extent', () => {
  const blob = cutClip(decoded, { offsetMs: 250, durationMs: 500 });
  assert.equal(blob.type, 'audio/wav');
  assert.equal(blob.size, 44 + 8000 * 2);
});

test('cutClip: a range selecting nothing yields null rather than an empty clip', () => {
  assert.equal(cutClip(decoded, { offsetMs: 9999, durationMs: 100 }), null);
  assert.equal(cutClip(decoded, { offsetMs: 0, durationMs: 0 }), null);
});

test('cutClip: a malformed range yields null instead of throwing', () => {
  assert.equal(cutClip(decoded, null), null);
  assert.equal(cutClip(null, { offsetMs: 0, durationMs: 100 }), null);
  assert.equal(cutClip(decoded, { offsetMs: null, durationMs: 100 }), null);
  assert.equal(cutClip(decoded, { offsetMs: 0, durationMs: NaN }), null);
});

test('cutClip: two adjacent clips of the same source are independent', () => {
  const first = cutClip(decoded, { offsetMs: 0, durationMs: 500 });
  const second = cutClip(decoded, { offsetMs: 500, durationMs: 500 });
  assert.equal(first.size, second.size);
  assert.equal(sliceSamples(decoded, 0, 500)[0], 0, 'the source is unchanged after both cuts');
});
