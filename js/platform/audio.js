// Audio sample handling: resampling, level normalisation, WAV encoding,
// decoding a file, and cutting a clip out of decoded samples.
//
// Everything except `decode` is arithmetic over Float32Array and runs anywhere.
// `decode` needs the browser's own decoder, which is the reason this module is
// in platform/ rather than model/.
//
// The output format is fixed at 16 kHz / 16-bit / mono WAV because the
// pronunciation assessment endpoint accepts only PCM WAV at 16 kHz or Ogg Opus.
// Capturing raw PCM and wrapping it ourselves means the same bytes can be both
// played back and scored; a MediaRecorder capture (WebM/Opus in Chrome) can do
// neither without a conversion step.

export const TARGET_RATE = 16_000;

/**
 * Resample to TARGET_RATE, returning a new array.
 *
 * Downsampling averages each input window rather than picking one sample from
 * it, which doubles as the anti-aliasing filter that naive decimation needs and
 * does not have.
 */
export function resampleTo16k(input, inputRate) {
  if (inputRate === TARGET_RATE) return input;
  const ratio = inputRate / TARGET_RATE;
  const length = Math.round(input.length / ratio);
  const out = new Float32Array(length);

  if (ratio > 1) {
    for (let i = 0; i < length; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(Math.floor((i + 1) * ratio), input.length);
      let sum = 0;
      let count = 0;
      for (let j = start; j < end; j++) { sum += input[j]; count++; }
      out[i] = count ? sum / count : 0;
    }
  } else {
    // Upsampling: linear interpolation between neighbouring samples.
    for (let i = 0; i < length; i++) {
      const position = i * ratio;
      const low = Math.floor(position);
      const high = Math.min(low + 1, input.length - 1);
      const fraction = position - low;
      out[i] = input[low] * (1 - fraction) + input[high] * fraction;
    }
  }
  return out;
}

/**
 * Scale samples so the loudest reaches `targetPeak`, returning a new array.
 *
 * Gain is capped so near-silence is lifted a little rather than amplified into
 * noise. Returning a copy rather than scaling in place is deliberate: an
 * in-place version means every caller holding the decoded source has to know to
 * defend against it, and one that forgets quietly corrupts every later slice
 * cut from the same buffer.
 */
export function normalize(samples, targetPeak = 0.95, maxGain = 30) {
  let peak = 0;
  for (const sample of samples) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  const out = new Float32Array(samples.length);
  if (peak === 0) return out;
  const gain = Math.min(targetPeak / peak, maxGain);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

const writeAscii = (view, offset, text) => {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
};

/** Encode Float32 samples as a 16 kHz / 16-bit / mono WAV. */
export function encodeWav(samples, inputRate) {
  const pcm = normalize(resampleTo16k(samples, inputRate));
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk length
  view.setUint16(20, 1, true); // PCM, uncompressed
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, pcm.length * 2, true);

  let offset = 44;
  for (const sample of pcm) {
    const clamped = Math.max(-1, Math.min(1, sample));
    // Asymmetric on purpose: signed 16-bit reaches -32768 but only +32767.
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

/** A WAV Blob from Float32 samples. */
export const encodeWavBlob = (samples, inputRate) => new Blob([encodeWav(samples, inputRate)], { type: 'audio/wav' });

/**
 * Samples covering [offsetMs, offsetMs + durationMs), clamped to what exists.
 *
 * Always a copy, so the decoded source stays intact for every other clip cut
 * from it.
 */
export function sliceSamples({ channelData, sampleRate }, offsetMs, durationMs) {
  const start = Math.max(0, Math.min(channelData.length, Math.round((offsetMs / 1000) * sampleRate)));
  const end = Math.max(start, Math.min(channelData.length, Math.round(((offsetMs + durationMs) / 1000) * sampleRate)));
  return channelData.slice(start, end);
}

/**
 * Cut one clip out of a decoded source and encode it.
 *
 * Every clip is cut from the original file rather than from an
 * already-derived one, so repeated splits and merges never compound
 * resampling and normalisation error. That is the reason the source file is
 * kept at all.
 *
 * @param {{channelData: Float32Array, sampleRate: number}} decoded
 * @param {{offsetMs: number, durationMs: number}} range
 * @returns {Blob|null} null when the range selects nothing.
 */
export function cutClip(decoded, range) {
  if (!decoded || !range || !Number.isFinite(range.offsetMs) || !Number.isFinite(range.durationMs)) return null;
  const samples = sliceSamples(decoded, range.offsetMs, range.durationMs);
  if (!samples.length) return null;
  return encodeWavBlob(samples, decoded.sampleRate);
}

/**
 * Decode an audio file into mono samples.
 *
 * Only the first channel is kept: everything downstream is mono, and the
 * assessment endpoint requires it.
 *
 * @returns {Promise<{channelData: Float32Array, sampleRate: number, durationMs: number}>}
 */
export async function decode(blob) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) throw new Error('This browser cannot decode audio (Web Audio API unavailable)');

  const bytes = await blob.arrayBuffer();
  const context = new AudioContextCtor();
  try {
    const decoded = await context.decodeAudioData(bytes);
    return {
      channelData: decoded.getChannelData(0),
      sampleRate: decoded.sampleRate,
      durationMs: decoded.duration * 1000,
    };
  } finally {
    // Closing is best-effort: an already-closed context rejects, and that must
    // not mask the decoded result or a genuine decode failure.
    context.close().catch(() => {});
  }
}
