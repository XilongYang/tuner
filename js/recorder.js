// Recording: capture PCM directly via the Web Audio API, output 16kHz / 16bit / mono WAV.
//
// Why not MediaRecorder?
// MediaRecorder produces webm/opus in Chrome, but Azure Pronunciation Assessment's
// short-audio REST endpoint only accepts `audio/wav (PCM 16k)` or `audio/ogg;opus`.
// So the same recording can be both played back and uploaded for scoring, we
// capture raw PCM and wrap it into a standard WAV (which the browser can play directly).

const TARGET_RATE = 16000;

/** Resample captured Float32 samples to 16kHz. */
function resampleTo16k(input, inputRate) {
  if (inputRate === TARGET_RATE) return input;
  const ratio = inputRate / TARGET_RATE;
  const newLen = Math.round(input.length / ratio);
  const out = new Float32Array(newLen);

  if (ratio > 1) {
    // Downsampling (e.g. 48k/44.1k → 16k): average the input window for each
    // output sample, which doubles as an anti-aliasing low-pass and avoids the
    // aliasing of naive sample picking.
    for (let i = 0; i < newLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(Math.floor((i + 1) * ratio), input.length);
      let sum = 0;
      let n = 0;
      for (let j = start; j < end; j++) { sum += input[j]; n++; }
      out[i] = n ? sum / n : 0;
    }
  } else {
    // Upsampling: linear interpolation
    for (let i = 0; i < newLen; i++) {
      const idx = i * ratio;
      const i0 = Math.floor(idx);
      const i1 = Math.min(i0 + 1, input.length - 1);
      const frac = idx - i0;
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
  }
  return out;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Peak normalization: scale the whole recording up to near full-scale, fixing
 * overly quiet raw microphone input. Because it scales the entire clip uniformly
 * after recording (unlike autoGainControl's dynamic adjustment), it introduces no
 * pumping or dropouts. The maxGain cap prevents blowing up near-silent noise floor.
 */
function normalize(samples, targetPeak = 0.95, maxGain = 30) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak === 0) return samples;
  const gain = Math.min(targetPeak / peak, maxGain);
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  return samples;
}

/** Encode Float32 PCM into a 16kHz/16bit/mono WAV, returning an ArrayBuffer. */
function encodeWav(float32, inputRate) {
  const pcm = normalize(resampleTo16k(float32, inputRate));
  const numSamples = pcm.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt chunk size
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, TARGET_RATE, true); // sample rate
  view.setUint32(28, TARGET_RATE * 2, true); // byte rate = rate × channels × bytesPerSample
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bit depth
  writeString(view, 36, 'data');
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

/** Concatenate multiple Float32Array chunks. */
function flatten(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export class Recorder {
  constructor() {
    this._audioContext = null;
    this._stream = null;
    this._source = null;
    this._workletNode = null;
    this._scriptNode = null;   // used only when AudioWorklet is unsupported
    this._silentGain = null;
    this._chunks = [];
    this._recording = false;
    this._sampleRate = TARGET_RATE;
    this._objectUrl = null;
  }

  get isRecording() {
    return this._recording;
  }

  /** Start recording. Throws if the browser doesn't support it or the user denies access. */
  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser does not support recording (getUserMedia unavailable)');
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      throw new Error('This browser does not support the Web Audio API');
    }

    try {
      // Use the browser's built-in audio enhancement (echo cancellation / noise
      // suppression / auto gain control).
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        throw new Error('Microphone permission denied. Please allow microphone access in your browser.');
      }
      throw new Error('Cannot access microphone: ' + (err && err.message ? err.message : err));
    }

    // Create the AudioContext at the device's native sample rate.
    // No longer forcing 16kHz: forcing a non-native rate triggers an audio device
    // reconfiguration that interrupts microphone capture mid-recording (the recording
    // icon flickers off) and causes dropouts. Capture at native rate, then resample
    // to 16kHz in encodeWav (the format Azure REST requires).
    this._audioContext = new AudioCtx();
    // The autoplay policy may leave the context suspended; resume it explicitly.
    if (this._audioContext.state === 'suspended') {
      try { await this._audioContext.resume(); } catch { /* ignore */ }
    }
    this._sampleRate = this._audioContext.sampleRate;
    this._source = this._audioContext.createMediaStreamSource(this._stream);
    this._chunks = [];

    if (this._audioContext.audioWorklet) {
      await this._startWithWorklet();
    } else {
      this._startWithScriptProcessor();
    }

    this._recording = true;
  }

  /** Preferred: AudioWorklet capture, processed on the audio thread, no dropped frames. */
  async _startWithWorklet() {
    const workletUrl = new URL('./recorder-worklet.js', import.meta.url);
    await this._audioContext.audioWorklet.addModule(workletUrl);

    this._workletNode = new AudioWorkletNode(this._audioContext, 'recorder-processor');
    this._workletNode.port.onmessage = (e) => {
      // e.data is one block of Float32Array samples
      if (this._recording && e.data && e.data.length) {
        this._chunks.push(e.data);
      }
    };

    // The worklet outputs silence by default (we don't write outputs); connect it to
    // destination so the graph keeps being pulled.
    this._source.connect(this._workletNode);
    this._workletNode.connect(this._audioContext.destination);
  }

  /** Fallback: ScriptProcessor for old browsers without AudioWorklet (may drop frames when the main thread is busy). */
  _startWithScriptProcessor() {
    this._scriptNode = this._audioContext.createScriptProcessor(4096, 1, 1);
    this._scriptNode.addEventListener('audioprocess', (e) => {
      if (!this._recording) return;
      this._chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    });
    this._silentGain = this._audioContext.createGain();
    this._silentGain.gain.value = 0;
    this._source.connect(this._scriptNode);
    this._scriptNode.connect(this._silentGain);
    this._silentGain.connect(this._audioContext.destination);
  }

  /**
   * Stop recording and return { blob, url } (WAV, playable and uploadable for scoring).
   * @returns {Promise<{ blob: Blob, url: string }>}
   */
  async stop() {
    if (!this._recording) throw new Error('Recording has not started');
    this._recording = false;

    if (this._source) this._source.disconnect();
    if (this._workletNode) {
      this._workletNode.port.onmessage = null;
      this._workletNode.disconnect();
    }
    if (this._scriptNode) this._scriptNode.disconnect();
    if (this._silentGain) this._silentGain.disconnect();

    const pcm = flatten(this._chunks);
    const wavBuffer = encodeWav(pcm, this._sampleRate);
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });

    this._releaseStream();
    if (this._audioContext) {
      try { await this._audioContext.close(); } catch { /* ignore */ }
      this._audioContext = null;
    }

    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
    this._objectUrl = URL.createObjectURL(blob);
    return { blob, url: this._objectUrl };
  }

  _releaseStream() {
    if (this._stream) {
      for (const track of this._stream.getTracks()) track.stop();
      this._stream = null;
    }
  }

  /** Release all resources. */
  dispose() {
    this._recording = false;
    this._releaseStream();
    if (this._audioContext) {
      try { this._audioContext.close(); } catch { /* ignore */ }
      this._audioContext = null;
    }
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = null;
    }
    this._source = null;
    this._workletNode = null;
    this._scriptNode = null;
    this._silentGain = null;
    this._chunks = [];
  }
}
