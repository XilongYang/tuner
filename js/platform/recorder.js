// Microphone capture, producing a 16 kHz mono WAV.
//
// Capture runs on an AudioWorklet -- an audio-thread processor, so a busy main
// thread cannot cause dropped blocks. The older ScriptProcessor fallback is
// deliberately not kept: it drops frames under exactly the conditions recording
// happens under, and every browser this app runs in has had AudioWorklet for
// years. An absent AudioWorklet is reported as unsupported rather than quietly
// recording worse audio.
//
// The recorder is an explicit state machine, and every entry point refuses to
// act unless the state allows it. That is not ceremony: a recorder whose start
// could run twice overwrites the first MediaStream without stopping it, and the
// microphone then stays live -- with the browser's recording indicator on --
// until the tab is closed. Teardown is one function, called on every exit path
// including every failure, so there is no path that leaks a stream.
//
// The browser pieces are injected with real defaults, which is what lets the
// state machine be tested without a microphone.

import { encodeWavBlob, TARGET_RATE } from './audio.js';

/** @typedef {'idle'|'starting'|'recording'|'stopping'|'disposed'} RecorderState */

const MIC_CONSTRAINTS = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

const defaultDeps = {
  getUserMedia: (constraints) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not support recording (getUserMedia unavailable)');
    }
    return navigator.mediaDevices.getUserMedia(constraints);
  },
  createAudioContext: () => {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('This browser does not support the Web Audio API');
    // Created at the device's native rate on purpose. Forcing 16 kHz here makes
    // the browser reconfigure the audio device mid-capture, which interrupts the
    // stream and drops audio; resampling happens at encode time instead.
    return new Ctor();
  },
  createWorkletNode: (context, name) => new AudioWorkletNode(context, name),
  workletModuleUrl: () => new URL('./recorder-worklet.js', import.meta.url),
};

export function createRecorder(deps = {}) {
  const { getUserMedia, createAudioContext, createWorkletNode, workletModuleUrl } = { ...defaultDeps, ...deps };

  /** @type {RecorderState} */
  let state = 'idle';
  let stream = null;
  let context = null;
  let source = null;
  let workletNode = null;
  let chunks = [];
  let sampleRate = TARGET_RATE;

  /**
   * Release everything, in an order that cannot leave the microphone live, and
   * safe to call from any state including a half-built one.
   */
  function teardown() {
    // Tracks first: this is what turns the microphone (and its indicator) off,
    // so it must not be reachable only after something else has succeeded.
    for (const track of stream?.getTracks?.() ?? []) {
      try { track.stop(); } catch { /* already ended */ }
    }
    stream = null;

    if (workletNode) {
      try { workletNode.port.onmessage = null; } catch { /* nothing listening */ }
      try { workletNode.disconnect(); } catch { /* never connected */ }
      workletNode = null;
    }
    if (source) {
      try { source.disconnect(); } catch { /* never connected */ }
      source = null;
    }
    if (context) {
      // Best-effort: an already-closed context rejects, which must not mask a
      // real failure being reported by the caller.
      try { context.close()?.catch?.(() => {}); } catch { /* already closed */ }
      context = null;
    }
  }

  function collected() {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    return samples;
  }

  return {
    get state() { return state; },
    get isRecording() { return state === 'recording'; },

    /**
     * Begin capturing.
     *
     * Refuses unless idle, so a double click cannot start a second capture over
     * the first. Any failure leaves the recorder idle with nothing held open.
     */
    async start() {
      if (state === 'disposed') throw new Error('This recorder has been disposed');
      if (state !== 'idle') return false;
      state = 'starting';
      chunks = [];

      try {
        stream = await getUserMedia(MIC_CONSTRAINTS);

        context = createAudioContext();
        // The autoplay policy can hand back a suspended context; without this
        // the graph is never pulled and the recording is silent.
        if (context.state === 'suspended') {
          try { await context.resume(); } catch { /* proceeds; a silent take is caught by the caller */ }
        }
        sampleRate = context.sampleRate;

        if (!context.audioWorklet) throw new Error('This browser does not support AudioWorklet, which recording requires');
        await context.audioWorklet.addModule(workletModuleUrl());

        source = context.createMediaStreamSource(stream);
        workletNode = createWorkletNode(context, 'recorder-processor');
        workletNode.port.onmessage = (event) => {
          // Blocks can still arrive while stopping; only take them while the
          // recorder considers itself recording.
          if (state === 'recording' && event.data?.length) chunks.push(event.data);
        };

        source.connect(workletNode);
        // The processor writes no output, but the graph is only pulled if it is
        // connected to a destination.
        workletNode.connect(context.destination);

        state = 'recording';
        return true;
      } catch (err) {
        teardown();
        state = 'idle';
        throw describeFailure(err);
      }
    },

    /**
     * Stop and return the take.
     *
     * Returns null if there was nothing recording, so a caller that raced its
     * own stop gets an answer rather than an exception.
     *
     * @returns {Promise<{blob: Blob, samples: Float32Array, sampleRate: number, durationMs: number}|null>}
     */
    async stop() {
      if (state !== 'recording') return null;
      state = 'stopping';
      const samples = collected();
      const rate = sampleRate;
      teardown();
      chunks = [];
      state = 'idle';

      return {
        blob: encodeWavBlob(samples, rate),
        samples,
        sampleRate: rate,
        durationMs: (samples.length / rate) * 1000,
      };
    },

    /** Stop and discard. Safe from any state. */
    async cancel() {
      if (state === 'disposed') return;
      teardown();
      chunks = [];
      state = 'idle';
    },

    /**
     * Release for good. A disposed recorder refuses to start, so a stale
     * reference held by a screen that has moved on cannot reopen the microphone.
     */
    dispose() {
      teardown();
      chunks = [];
      state = 'disposed';
    },
  };
}

/** Turn a capture failure into something a person can act on. */
function describeFailure(err) {
  if (err?.name === 'NotAllowedError') {
    return new Error('Microphone permission denied. Allow microphone access in your browser to record.');
  }
  if (err?.name === 'NotFoundError') {
    return new Error('No microphone found. Connect one and try again.');
  }
  return err instanceof Error ? err : new Error(`Cannot access the microphone: ${err}`);
}
