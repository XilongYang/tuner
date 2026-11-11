// One microphone, held by one thing at a time -- over recorders the test
// controls, so every way of letting go is observable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMicrophone } from '../../js/platform/microphone.js';

function fakeRecorder({ startResult = true, startFails = false, stopFails = false } = {}) {
  let recording = false;
  let release;
  const recorder = {
    get isRecording() { return recording; },
    disposed: false,
    started: new Promise((resolve) => { release = resolve; }),
    async start() {
      if (startFails) throw new Error('denied');
      await recorder.started;
      recording = startResult;
      return startResult;
    },
    async stop() {
      recording = false;
      if (stopFails) throw new Error('the device went away');
      return { blob: new Blob(), durationMs: 10 };
    },
    dispose() { recording = false; recorder.disposed = true; },
    finishStarting: () => release(),
  };
  return recorder;
}

function harness(opts) {
  const recorders = [];
  const owners = [];
  const microphone = createMicrophone({
    createRecorder: () => { const r = fakeRecorder(opts); recorders.push(r); return r; },
  });
  microphone.subscribe((owner) => owners.push(owner));
  return { microphone, recorders, owners, last: () => recorders.at(-1) };
}

test('a handle records in its own name, and lets go when the take is stopped', async () => {
  const h = harness();
  const row = h.microphone.for('s1');

  const starting = row.start();
  assert.equal(h.microphone.owner(), 's1', 'held from the moment it is asked for');
  h.last().finishStarting();
  assert.equal(await starting, true);
  assert.equal(row.isRecording, true);

  const take = await row.stop();
  assert.ok(take.blob);
  assert.equal(h.microphone.owner(), null);
  assert.equal(h.last().disposed, true);
  assert.deepEqual(h.owners, ['s1', null]);
});

test('while one holds it, another is refused -- not queued, not given a second recorder', async () => {
  const h = harness();
  const row = h.microphone.for('s1');
  const retest = h.microphone.for('s1:word:hello');
  row.start();
  h.last().finishStarting();

  assert.equal(await retest.start(), false);
  assert.equal(h.recorders.length, 1);
  assert.equal(retest.isRecording, false);
  assert.equal(h.microphone.isHeldBy('s1'), true);
});

test('stop in someone else\'s name does nothing and returns nothing', async () => {
  const h = harness();
  h.microphone.for('s1').start();
  h.last().finishStarting();
  await Promise.resolve();

  assert.equal(await h.microphone.for('s2').stop(), null);
  assert.equal(h.microphone.owner(), 's1', 'still theirs');
});

test('release lets go of whoever holds it, discarding the take', async () => {
  const h = harness();
  h.microphone.for('s1').start();
  h.last().finishStarting();
  await Promise.resolve();

  h.microphone.release();
  assert.equal(h.microphone.owner(), null);
  assert.equal(h.last().disposed, true);
});

test('release in a name only lets go if that name holds it', async () => {
  const h = harness();
  h.microphone.for('s1').start();
  h.last().finishStarting();
  await Promise.resolve();

  h.microphone.release('s1:word:hello');
  assert.equal(h.microphone.owner(), 's1', 'a popover closing does not stop the row\'s take');
  h.microphone.release('s1');
  assert.equal(h.microphone.owner(), null);
});

test('released while still starting: the start reports false and nothing is left held', async () => {
  // The permission prompt is up and the session is left. The recorder itself
  // refuses to finish starting once disposed; the holder must agree with it.
  const h = harness({ startResult: false });
  const row = h.microphone.for('s1');
  const starting = row.start();
  h.microphone.release();
  h.last().finishStarting();

  assert.equal(await starting, false);
  assert.equal(h.microphone.owner(), null);
  assert.equal(h.last().disposed, true);
  assert.deepEqual(h.owners, ['s1', null], 'announced once on the way out, not again');
});

test('a start that throws lets go and rethrows, so the caller can say why', async () => {
  const h = harness({ startFails: true });
  await assert.rejects(h.microphone.for('s1').start(), /denied/);
  assert.equal(h.microphone.owner(), null);
  assert.equal(h.last().disposed, true);
  assert.equal(await h.microphone.for('s2').start().then(() => true, () => true), true, 'and the next one can try');
});

test('a stop that throws still lets go: a failed device must not hold the microphone for the life of the page', async () => {
  const h = harness({ stopFails: true });
  const row = h.microphone.for('s1');
  row.start();
  h.last().finishStarting();
  await Promise.resolve();

  await assert.rejects(row.stop(), /the device went away/);
  assert.equal(h.microphone.owner(), null);
  assert.equal(h.last().disposed, true);
});

test('a new holder after a release is not disturbed by the old one finishing', async () => {
  const h = harness();
  const first = h.microphone.for('s1');
  const starting = first.start();
  h.microphone.release();

  const second = h.microphone.for('s2');
  second.start();
  h.recorders[1].finishStarting();
  h.recorders[0].finishStarting();
  await starting;
  await Promise.resolve();

  assert.equal(h.microphone.owner(), 's2');
  assert.equal(h.recorders[1].disposed, false);
});
