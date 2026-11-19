// What a round does around itself, in what order, and what the screen does afterwards -- with
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

function harness({ configured = true, stored = null, outcome = { ok: true }, auto = false } = {}) {
  const timers = [];
  const store = createSessionStore(session());
  const events = [];
  const rounds = [];
  const flushes = [];
  let finish = [];

  const scheduler = createSyncScheduler({
    store,
    db: { getOne: async () => stored },
    settings: {},
    hash: {},
    autosave: { flush: async () => flushes.push('flush'), reset: () => {} },
    container: () => (configured ? { name: 'container' } : null),
    clock: () => 777,
    ...(auto ? {
      schedule: (fn) => { timers.push(fn); return timers.length; },
      cancel: (handle) => { timers[handle - 1] = null; },
    } : { schedule: () => 0, cancel: () => {} }),
    sync: ({ deps }) => new Promise((resolve) => {
      rounds.push(deps);
      // Each round is finished by the test, so overlap is observable.
      finish.push((result = outcome) => resolve(result));
    }),
    erase: async ({ deps }) => { rounds.push({ erase: true, ...deps }); return { ok: true, deleted: 3 }; },
  });
  scheduler.subscribe((event) => events.push(event));

  return {
    store, scheduler, events, rounds, flushes,
    get timers() { return timers.filter(Boolean); },
    fire: async () => { timers.filter(Boolean).forEach((fn) => fn()); await settle(); },
    finishRound: async (result) => { finish.shift()?.(result); await settle(); },
  };
}

test('edits settle, then one round: a burst is one thing to publish', async () => {
  const h = harness({ auto: true });
  h.store.apply((s) => ({ ...s, name: 'typed' }), 'describe');
  h.store.apply((s) => ({ ...s, name: 'typed more' }), 'describe');
  assert.equal(h.timers.length, 1, 'the first timer was cancelled by the second edit');
  await h.fire();
  assert.equal(h.rounds.length, 1);
  assert.deepEqual(h.flushes, ['flush'], 'what was typed is saved before the round plans');
  await h.finishRound();
});

test('what a save writes back and what a round brought in are not edits', async () => {
  const h = harness({ auto: true });
  h.store.apply((s) => s, 'saved');
  h.store.apply((s) => s, 'incoming');
  assert.equal(h.timers.length, 0);
});

test('with no container, editing starts nothing', async () => {
  const h = harness({ auto: true, configured: false });
  h.store.apply((s) => ({ ...s, name: 'typed' }), 'describe');
  assert.equal(h.timers.length, 0);
});

test('a requested round flushes the save first, so it plans against what was just typed', async () => {
  const h = harness();
  const request = h.scheduler.request();
  await settle();
  assert.deepEqual(h.flushes, ['flush']);
  assert.equal(h.rounds.length, 1);
  await h.finishRound();
  await request;
}) ;

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

test('an erase goes down the same lane as the rounds', async () => {
  const h = harness();
  const request = h.scheduler.request();
  const erasing = h.scheduler.erase();
  await settle();
  assert.equal(h.rounds.length, 1, 'the erase waits for the round holding the lock');
  await h.finishRound();
  await Promise.all([request, erasing]);

  assert.equal(h.rounds[1].erase, true);
});

test('reportAvailability runs a round when there is a container, and turns the indicator off when there is none', async () => {
  const configured = harness();
  const running = configured.scheduler.reportAvailability();
  await settle();
  assert.equal(configured.rounds.length, 1);
  await configured.finishRound();
  await running;

  const off = harness({ configured: false });
  await off.scheduler.reportAvailability();
  assert.deepEqual(off.events, [{ phase: 'off' }]);
  assert.equal(off.rounds.length, 0);
});
