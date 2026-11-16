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

function harness({ configured = true, stored = null, outcome = { ok: true } } = {}) {
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
    finishRound: async (result) => { finish.shift()?.(result); await settle(); },
  };
}

test('editing never starts a round: syncing is manual', async () => {
  const h = harness();
  h.store.apply((s) => ({ ...s, name: 'typed' }), 'describe');
  h.store.apply((s) => ({ ...s, name: 'typed more' }), 'describe');
  await settle();
  assert.equal(h.rounds.length, 0);
});

test('start runs no round either, and tells the indicator when there is nowhere to sync', async () => {
  const configured = harness();
  configured.scheduler.start();
  await settle();
  assert.equal(configured.rounds.length, 0);
  assert.deepEqual(configured.events, []);

  const off = harness({ configured: false });
  off.scheduler.start();
  assert.deepEqual(off.events, [{ phase: 'off' }]);
  assert.equal(off.rounds.length, 0);
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

test('a container being set does not start a round; one being forgotten turns the indicator off', async () => {
  let configured = true;
  const h = harness();
  let rounds = 0;
  const scheduler = createSyncScheduler({
    store: h.store, db: { getOne: async () => null }, settings: {}, hash: {},
    autosave: { flush: async () => {} },
    container: () => (configured ? {} : null),
    sync: async () => { rounds += 1; return { ok: true }; },
  });
  const events = [];
  scheduler.subscribe((e) => events.push(e.phase));

  scheduler.containerChanged();
  assert.deepEqual(events, []);
  assert.equal(rounds, 0);

  configured = false;
  scheduler.containerChanged();
  assert.deepEqual(events, ['off']);
});
