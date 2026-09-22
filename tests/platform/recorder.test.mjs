// The recorder's state machine and teardown, tested without a microphone by
// injecting the browser pieces.
//
// The behaviour worth guarding is not "does it record" -- it is that no path
// leaves the microphone open. A previous version could start twice, replacing
// the first MediaStream without stopping it, which left the mic live and the
// browser's recording indicator on until the tab was closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder } from '../../js/platform/recorder.js';

function fakeEnvironment({ failAt = null, contextState = 'running', sampleRate = 48_000, noWorklet = false } = {}) {
  const tracks = [];
  const log = [];

  const track = () => {
    const t = { stopped: false, stop() { this.stopped = true; log.push('track.stop'); } };
    tracks.push(t);
    return t;
  };

  let node = null;
  const context = {
    state: contextState,
    sampleRate,
    destination: { id: 'destination' },
    resume: async () => { log.push('context.resume'); context.state = 'running'; },
    close: async () => { log.push('context.close'); context.closed = true; },
    audioWorklet: noWorklet ? undefined : { addModule: async () => { if (failAt === 'addModule') throw new Error('module blew up'); log.push('addModule'); } },
    createMediaStreamSource: () => {
      if (failAt === 'source') throw new Error('source blew up');
      return { connect: () => log.push('source.connect'), disconnect: () => log.push('source.disconnect') };
    },
    closed: false,
  };

  const deps = {
    getUserMedia: async () => {
      if (failAt === 'getUserMedia') {
        const err = new Error('denied');
        err.name = 'NotAllowedError';
        throw err;
      }
      log.push('getUserMedia');
      return { getTracks: () => tracks, _track: track() };
    },
    createAudioContext: () => {
      if (failAt === 'createAudioContext') throw new Error('no audio');
      return context;
    },
    createWorkletNode: () => {
      if (failAt === 'createWorkletNode') throw new Error('node blew up');
      node = {
        port: { onmessage: null },
        connect: () => log.push('node.connect'),
        disconnect: () => log.push('node.disconnect'),
      };
      return node;
    },
    workletModuleUrl: () => 'fake://worklet',
  };

  return {
    deps,
    log,
    context,
    tracks,
    node: () => node,
    /** Feed captured blocks the way the worklet would. */
    emit: (...blocks) => { for (const b of blocks) node.port.onmessage({ data: Float32Array.from(b) }); },
    micIsLive: () => tracks.length > 0 && tracks.some((t) => !t.stopped),
  };
}

test('start: moves idle -> recording', async () => {
  const env = fakeEnvironment();
  const recorder = createRecorder(env.deps);
  assert.equal(recorder.state, 'idle');
  assert.equal(recorder.isRecording, false);

  assert.equal(await recorder.start(), true);
  assert.equal(recorder.state, 'recording');
  assert.equal(recorder.isRecording, true);
});

test('start: a second call while recording is refused, and does NOT open a second stream', async () => {
  // The double-click case. A second getUserMedia would replace the first stream
  // with nothing stopping it, leaving the microphone live indefinitely.
  const env = fakeEnvironment();
  const recorder = createRecorder(env.deps);
  await recorder.start();

  assert.equal(await recorder.start(), false);
  assert.equal(env.log.filter((entry) => entry === 'getUserMedia').length, 1);
  assert.equal(env.tracks.length, 1);
});

test('start: two concurrent calls only open one stream', async () => {
  const env = fakeEnvironment();
  const recorder = createRecorder(env.deps);

  const [first, second] = await Promise.all([recorder.start(), recorder.start()]);
  assert.deepEqual([first, second].sort(), [false, true]);
  assert.equal(env.tracks.length, 1, 'the concurrent call was refused before touching the microphone');
});

test('start: resumes a suspended context, or the take would be silent', async () => {
  const env = fakeEnvironment({ contextState: 'suspended' });
  await createRecorder(env.deps).start();
  assert.ok(env.log.includes('context.resume'));
});

test('start: connects the node to a destination so the graph is actually pulled', async () => {
  const env = fakeEnvironment();
  await createRecorder(env.deps).start();
  assert.ok(env.log.includes('source.connect'));
  assert.ok(env.log.includes('node.connect'));
});

test('stop: returns a WAV of the captured blocks and leaves the recorder idle', async () => {
  const env = fakeEnvironment({ sampleRate: 16_000 });
  const recorder = createRecorder(env.deps);
  await recorder.start();
  env.emit([0.5, -0.5], [0.25, -0.25]);

  const take = await recorder.stop();
  assert.equal(recorder.state, 'idle');
  assert.equal(take.blob.type, 'audio/wav');
  assert.equal(take.samples.length, 4);
  assert.equal(take.sampleRate, 16_000);
  assert.equal(take.durationMs, 0.25);
  assert.equal(take.blob.size, 44 + 4 * 2);
});

test('stop: releases the microphone', async () => {
  const env = fakeEnvironment();
  const recorder = createRecorder(env.deps);
  await recorder.start();
  assert.equal(env.micIsLive(), true);

  await recorder.stop();
  assert.equal(env.micIsLive(), false);
  assert.ok(env.context.closed, 'and closes the audio context');
});

test('stop: when nothing is recording it answers null rather than throwing', async () => {
  const recorder = createRecorder(fakeEnvironment().deps);
  assert.equal(await recorder.stop(), null);
});

test('stop: blocks arriving after the stop are not added to the take', async () => {
  const env = fakeEnvironment({ sampleRate: 16_000 });
  const recorder = createRecorder(env.deps);
  await recorder.start();
  env.emit([1, 1]);
  const node = env.node();

  const take = await recorder.stop();
  // A block already in flight on the audio thread arrives late.
  node.port.onmessage?.({ data: Float32Array.from([9, 9]) });

  assert.equal(take.samples.length, 2);
});

test('a second take starts clean rather than appending to the first', async () => {
  const env = fakeEnvironment({ sampleRate: 16_000 });
  const recorder = createRecorder(env.deps);

  await recorder.start();
  env.emit([1, 1, 1]);
  await recorder.stop();

  await recorder.start();
  env.emit([0.5]);
  const second = await recorder.stop();

  assert.equal(second.samples.length, 1);
});

test('a denied microphone reports something actionable and leaves nothing open', async () => {
  const env = fakeEnvironment({ failAt: 'getUserMedia' });
  const recorder = createRecorder(env.deps);

  await assert.rejects(() => recorder.start(), /permission denied/i);
  assert.equal(recorder.state, 'idle');
  assert.equal(env.micIsLive(), false);
});

test('a failure AFTER the microphone opens still releases it', async () => {
  // Every step between getUserMedia and 'recording' is a chance to leak the
  // stream, so each is checked.
  for (const failAt of ['createAudioContext', 'addModule', 'source', 'createWorkletNode']) {
    const env = fakeEnvironment({ failAt });
    const recorder = createRecorder(env.deps);

    await assert.rejects(() => recorder.start(), undefined, `failing at ${failAt}`);
    assert.equal(env.micIsLive(), false, `microphone released when failing at ${failAt}`);
    assert.equal(recorder.state, 'idle', `recorder idle again after failing at ${failAt}`);
  }
});

test('a browser with no AudioWorklet is reported as unsupported, not quietly degraded', async () => {
  const env = fakeEnvironment({ noWorklet: true });
  const recorder = createRecorder(env.deps);

  await assert.rejects(() => recorder.start(), /AudioWorklet/);
  assert.equal(env.micIsLive(), false);
});

test('after a failed start the recorder can still be started again', async () => {
  const failing = fakeEnvironment({ failAt: 'createAudioContext' });
  const recorder = createRecorder(failing.deps);
  await assert.rejects(() => recorder.start());

  const working = fakeEnvironment();
  const second = createRecorder(working.deps);
  assert.equal(await second.start(), true);
});

test('cancel: releases everything and discards the take', async () => {
  const env = fakeEnvironment();
  const recorder = createRecorder(env.deps);
  await recorder.start();
  env.emit([1, 1]);

  await recorder.cancel();
  assert.equal(recorder.state, 'idle');
  assert.equal(env.micIsLive(), false);
  assert.equal(await recorder.stop(), null, 'nothing was kept');
});

test('cancel: is safe when nothing is running', async () => {
  const recorder = createRecorder(fakeEnvironment().deps);
  await recorder.cancel();
  assert.equal(recorder.state, 'idle');
});

test('dispose: releases the microphone and refuses to be started again', async () => {
  // A stale recorder held by a screen that has moved on must not be able to
  // reopen the microphone.
  const env = fakeEnvironment();
  const recorder = createRecorder(env.deps);
  await recorder.start();

  recorder.dispose();
  assert.equal(recorder.state, 'disposed');
  assert.equal(env.micIsLive(), false);
  await assert.rejects(() => recorder.start(), /disposed/);
});

test('dispose: is safe to call twice, and while idle', () => {
  const recorder = createRecorder(fakeEnvironment().deps);
  recorder.dispose();
  recorder.dispose();
  assert.equal(recorder.state, 'disposed');
});

test('dispose while the permission prompt is open does not leave the microphone on', async () => {
  // The screen that asked can be gone before the prompt is answered. A
  // continuation that carried on regardless would set the recorder recording
  // after it had been disposed, with nothing left holding a reference to the
  // stream -- the browser's recording indicator stays on until the tab closes.
  let answer;
  const env = fakeEnvironment();
  env.deps.getUserMedia = () => new Promise((resolve) => { answer = resolve; });

  const recorder = createRecorder(env.deps);
  const starting = recorder.start();
  recorder.dispose();

  answer({ getTracks: () => env.tracks, _track: null });
  assert.equal(await starting, false, 'the start reports that it did not happen');
  assert.equal(recorder.state, 'disposed');
  assert.equal(recorder.isRecording, false);
  assert.equal(env.micIsLive(), false, 'and the stream it was handed is stopped');
});

test('cancel while the worklet module is loading leaves nothing running', async () => {
  let finishModule;
  const env = fakeEnvironment();
  env.context.audioWorklet = { addModule: () => new Promise((resolve) => { finishModule = resolve; }) };

  const recorder = createRecorder(env.deps);
  const starting = recorder.start();
  await Promise.resolve();
  await recorder.cancel();

  finishModule();
  assert.equal(await starting, false);
  assert.equal(recorder.state, 'idle', 'and it can be started again');
  assert.equal(env.micIsLive(), false);
  assert.equal(env.context.closed, true);
});
