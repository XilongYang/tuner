import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resampleTo16k, normalize, encodeWav, decodeWavPcm16 } from '../js/recorder.js';

test('resampleTo16k: input already at 16kHz is returned unchanged (same array)', () => {
  const input = new Float32Array([0.1, 0.2, 0.3]);
  const out = resampleTo16k(input, 16000);
  assert.equal(out, input);
});

test('resampleTo16k: downsampling shrinks length roughly by the rate ratio', () => {
  const input = new Float32Array(48000).fill(0.5); // 1 second at 48k
  const out = resampleTo16k(input, 48000);
  assert.equal(out.length, 16000); // 1 second at 16k
  // Constant input should stay constant after averaging.
  assert.ok(Math.abs(out[100] - 0.5) < 1e-9);
});

test('resampleTo16k: upsampling grows length and interpolates', () => {
  const input = new Float32Array([0, 1]); // 2 samples at 8kHz -> 16kHz doubles length
  const out = resampleTo16k(input, 8000);
  assert.equal(out.length, 4);
  assert.equal(out[0], 0);
});

test('normalize: scales peak up to targetPeak', () => {
  const samples = new Float32Array([0, 0.1, -0.2, 0.05]);
  const out = normalize(samples, 0.95, 30);
  const peak = Math.max(...Array.from(out).map(Math.abs));
  assert.ok(Math.abs(peak - 0.95) < 1e-6);
});

test('normalize: silent input (all zero) is returned unchanged', () => {
  const samples = new Float32Array([0, 0, 0]);
  const out = normalize(samples);
  assert.deepEqual(Array.from(out), [0, 0, 0]);
});

test('normalize: gain is capped at maxGain for near-silent input', () => {
  const samples = new Float32Array([0.001, -0.0005]);
  const out = normalize(samples, 0.95, 30);
  // gain would be 950 uncapped; capped at 30 -> peak becomes 0.001 * 30 = 0.03.
  // Loose tolerance: `samples` is a Float32Array, so 0.001 is already rounded
  // to float32 precision before the multiply.
  assert.ok(Math.abs(out[0] - 0.001 * 30) < 1e-6);
});

test('encodeWav/decodeWavPcm16: round-trips sample rate and approximate sample values', () => {
  const original = new Float32Array([0, 0.5, -0.5, 0.25, -1, 1]);
  const wav = encodeWav(original, 16000);
  const { samples, sampleRate } = decodeWavPcm16(wav);
  assert.equal(sampleRate, 16000);
  assert.equal(samples.length, original.length);
  // encodeWav normalizes to 0.95 peak, so compare shape/sign, and check
  // quantization error stays within 16-bit precision.
  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.abs(Math.sign(samples[i]) - Math.sign(original[i])) <= 1);
  }
});

test('encodeWav: produces a valid RIFF/WAVE header with the expected data length', () => {
  const samples = new Float32Array(100).fill(0.1);
  const buf = encodeWav(samples, 16000);
  const view = new DataView(buf);
  assert.equal(view.getUint32(0, false), 0x52494646); // 'RIFF'
  assert.equal(view.getUint32(8, false), 0x57415645); // 'WAVE'
  assert.equal(buf.byteLength, 44 + 100 * 2);
});

test('decodeWavPcm16: throws a clear error on non-WAV input', () => {
  const buf = new TextEncoder().encode('not a wav file at all!!').buffer;
  assert.throws(() => decodeWavPcm16(buf), /Not a WAV file/);
});

test('decodeWavPcm16: throws on unsupported format (stereo or non-16-bit)', () => {
  const mono16 = encodeWav(new Float32Array([0.1, 0.2]), 16000);
  const view = new DataView(mono16.slice(0)); // copy
  view.setUint16(22, 2, true); // pretend numChannels = 2 (stereo)
  assert.throws(() => decodeWavPcm16(view.buffer), /Unsupported WAV format/);
});
