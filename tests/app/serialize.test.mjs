// One run at a time, and at most one waiting behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialize } from '../../js/app/serialize.js';

/** Let every pending microtask and the timer queue drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A function whose runs are finished by hand, so overlap is observable. */
function controllable() {
  const started = [];
  const finish = [];
  const fn = serialize(async (label) => {
    started.push(label);
    await new Promise((resolve) => finish.push(resolve));
    return label;
  });
  return { fn, started, release: () => finish.shift()?.() };
}

test('a call while one is running does not start a second run', async () => {
  const c = controllable();
  const first = c.fn('a');
  const second = c.fn('b');
  await settle();

  assert.deepEqual(c.started, ['a'], 'the second is waiting, not overlapping');

  c.release();
  await first;
  await settle();
  assert.deepEqual(c.started, ['a', 'b'], 'and starts once the first is done');

  c.release();
  assert.equal(await second, 'b');
});

test('several calls during one run collapse into one waiting run', async () => {
  // The fifth request made during one long run wants what the second one did.
  const c = controllable();
  const first = c.fn('a');
  const waiting = [c.fn('b'), c.fn('c'), c.fn('d')];
  await settle();

  c.release();
  await first;
  await settle();
  c.release();

  assert.deepEqual(await Promise.all(waiting), ['b', 'b', 'b'], 'one run, one answer');
  assert.deepEqual(c.started, ['a', 'b']);
});

test('a call after everything has finished starts a fresh run', async () => {
  const c = controllable();
  const first = c.fn('a');
  await settle();
  c.release();
  await first;

  const second = c.fn('b');
  await settle();
  c.release();

  assert.equal(await second, 'b');
  assert.deepEqual(c.started, ['a', 'b']);
});

test('a failed run does not block the one waiting behind it', async () => {
  const runs = [];
  const fn = serialize(async (label) => {
    runs.push(label);
    if (label === 'a') throw new Error('nope');
    return label;
  });

  const first = fn('a');
  const second = fn('b');

  await assert.rejects(first, /nope/, 'and the caller of the failed run still sees it fail');
  assert.equal(await second, 'b');
  assert.deepEqual(runs, ['a', 'b']);
});

test('a failure does not wedge it: the next call runs', async () => {
  const fn = serialize(async (label) => { if (label === 'a') throw new Error('nope'); return label; });

  await assert.rejects(fn('a'), /nope/);
  assert.equal(await fn('b'), 'b');
});

test('the arguments are the caller\'s own', async () => {
  const seen = [];
  const fn = serialize(async (...args) => { seen.push(args); });

  await fn(1, 2);
  await fn(3);

  assert.deepEqual(seen, [[1, 2], [3]]);
});
