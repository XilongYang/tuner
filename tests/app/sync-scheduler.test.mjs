// When rounds run, in what order, and what the screen does afterwards -- with
// the round itself replaced by a function the test controls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncScheduler } from '../../js/app/sync-scheduler.js';
import { createSessionStore } from '../../js/app/store.js';
import { blankSentence } from '../../js/model/session.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const session = (over = {}) => ({
  id: 'sess1', name: null, splitMode: 'auto', sortKey: 'i',
  createdAt: 1, updatedAt: 10, metaUpdatedAt: 10,
  inputText: null, inputTextHash: null, sourceAudio: null, sourceAudioHash: null,
  sentences: [blankSentence({ id: 's1', text: 'hello', lang: 'en', now: 10 })],
  ...over,
});

function harness({ configured = true, stored = null, outcome = { ok: true } } = {}) {
  const store = createSessionStore(session());
  const events = [];
  const rounds = [];
  const flushes = [];
  const timers = [];
  let finish = [];

  const scheduler = createSyncScheduler({
    store,
    db: { getOne: async () => stored },
    settings: {},
    hash: {},
    autosave: { flush: async () => flushes.push('flush'), reset: () => {} },
    container: () => (configured ? { name: 'container' } : null),
    clock: () => 777,
    sync: ({ deps }) => new Promise((resolve) => {
      rounds.push(deps);
      // Each round is finished by the test, so overlap is observable.
      finish.push((result = outcome) => resolve(result));
    }),
    erase: async ({ deps }) => { rounds.push({ erase: true, ...deps }); return { ok: true, deleted: 3 }; },
    delayMs: 3000,
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancel: (handle) => { timers[handle - 1].cancelled = true; },
  });
  scheduler.subscribe((event) => events.push(event));

  return {
    store, scheduler, events, rounds, flushes, timers,
    finishRound: async (result) => { finish.shift()?.(result); await settle(); },
    pendingTimers: () => timers.filter((t) => !t.cancelled && !t.fired),
    fire: async (timer) => { timer.fired = true; await timer.fn(); },
  };
}

test('an edit settles, the save is flushed, then one round runs', async () => {
  const h = harness();
  h.store.apply((s) => ({ ...s, name: 'typed' }), 'describe');

  assert.equal(h.pendingTimers().length, 1);
  assert.equal(h.pendingTimers()[0].ms, 3000);
  const firing = h.fire(h.pendingTimers()[0]);
  await settle();
  assert.deepEqual(h.flushes, ['flush'], 'what was just typed is written before the round plans');
  assert.equal(h.rounds.length, 1);
  await h.finishRound();
  await firing;
});

test('a burst of edits is one round, not one per keystroke', async () => {
  const h = harness();
  h.store.apply((s) => ({ ...s, name: 'a' }), 'describe');
  h.store.apply((s) => ({ ...s, name: 'ab' }), 'describe');
  h.store.apply((s) => ({ ...s, name: 'abc' }), 'describe');

  assert.equal(h.timers.length, 3);
  assert.equal(h.pendingTimers().length, 1, 'the earlier two were cancelled');
});

test('a save writing back, or a round landing, is not an edit', async () => {
  const h = harness();
  h.store.apply((s) => ({ ...s }), 'saved');
  h.store.replace(session({ name: 'from elsewhere' }), 'incoming');
  assert.equal(h.timers.length, 0);
});

test('with no container nothing is scheduled, and start says the indicator is off', async () => {
  const h = harness({ configured: false });
  h.store.apply((s) => ({ ...s, name: 'typed' }), 'describe');
  assert.equal(h.timers.length, 0);

  await h.scheduler.start();
  assert.deepEqual(h.events, [{ phase: 'off' }]);
  assert.equal(h.rounds.length, 0);
});

test('a round announces itself: started, each step of progress, then the outcome with the time', async () => {
  const h = harness();
  const request = h.scheduler.request();
  await settle();
  h.rounds[0].onProgress({ done: 1, total: 2 });
  await h.finishRound({ ok: true, uploaded: 1 });
  await request;

  assert.deepEqual(h.events.map((e) => e.phase), ['started', 'progress', 'finished']);
  assert.deepEqual(h.events[1].progress, { done: 1, total: 2 });
  assert.deepEqual(h.events[2], { phase: 'finished', outcome: { ok: true, uploaded: 1 }, at: 777 });
});

test('the caller of a round sees the same progress the indicator does', async () => {
  const h = harness();
  const seen = [];
  const request = h.scheduler.request((p) => seen.push(p));
  await settle();
  h.rounds[0].onProgress({ done: 2, total: 2 });
  await h.finishRound();
  await request;
  assert.deepEqual(seen, [{ done: 2, total: 2 }]);
});

test('after a round that landed, a changed stored copy of the session on screen is put back', async () => {
  const changed = session({ name: 'renamed on another device', updatedAt: 50, metaUpdatedAt: 50 });
  const h = harness({ stored: changed });

  const request = h.scheduler.request();
  await settle();
  await h.finishRound();
  await request;

  assert.equal(h.store.get().name, 'renamed on another device');
});

test('after a round that changed nothing, the session on screen is left exactly as it was', async () => {
  // A fresh read of the same record: the same hashes, different objects.
  const h = harness({ stored: session() });
  const onScreen = h.store.get();
  const version = h.store.version();

  const request = h.scheduler.request();
  await settle();
  await h.finishRound();
  await request;

  assert.equal(h.store.get(), onScreen, 'the same object, so nothing pinned to it is superseded');
  assert.equal(h.store.version(), version);
});

test('a round that failed does not touch the screen', async () => {
  const h = harness({ stored: session({ name: 'would have landed', updatedAt: 50 }) });
  const request = h.scheduler.request();
  await settle();
  await h.finishRound({ ok: false, reason: 'network' });
  await request;
  assert.equal(h.store.get().name, null);
});

test('two requests run one after the other, never together', async () => {
  const h = harness();
  const first = h.scheduler.request();
  const second = h.scheduler.request();
  await settle();
  assert.equal(h.rounds.length, 1, 'the second waits');
  await h.finishRound();
  assert.equal(h.rounds.length, 2, 'and starts once the first is done');
  await h.finishRound();
  await Promise.all([first, second]);
});

test('an erase goes down the same lane as the rounds, with the same cache', async () => {
  const h = harness();
  const request = h.scheduler.request();
  const erasing = h.scheduler.erase();
  await settle();
  assert.equal(h.rounds.length, 1, 'the erase waits for the round holding the lock');
  await h.finishRound();
  await Promise.all([request, erasing]);

  assert.equal(h.rounds[1].erase, true);
  assert.equal(h.rounds[1].manifestCache, h.rounds[0].manifestCache, 'one cache for both');
});

test('a container being set starts a round; one being forgotten turns the indicator off', async () => {
  let configured = true;
  const h = harness();
  // Re-point the container function through the harness's closure.
  const scheduler = createSyncScheduler({
    store: h.store, db: { getOne: async () => null }, settings: {}, hash: {},
    autosave: { flush: async () => {} },
    container: () => (configured ? {} : null),
    sync: async () => ({ ok: true }),
  });
  const events = [];
  scheduler.subscribe((e) => events.push(e.phase));

  await scheduler.containerChanged();
  assert.deepEqual(events, ['started', 'finished']);

  configured = false;
  await scheduler.containerChanged();
  assert.deepEqual(events.at(-1), 'off');
});

test('stop: a pending round is cancelled and edits no longer schedule one', async () => {
  const h = harness();
  h.store.apply((s) => ({ ...s, name: 'a' }), 'describe');
  h.scheduler.stop();
  assert.equal(h.pendingTimers().length, 0);
  h.store.apply((s) => ({ ...s, name: 'b' }), 'describe');
  assert.equal(h.timers.length, 1, 'nothing new');
});
