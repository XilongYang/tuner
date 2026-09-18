import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutosave } from '../../js/app/autosave.js';
import { createSessionStore } from '../../js/app/store.js';
import { blankSentence, updateSentence } from '../../js/model/session.js';

const session = (over = {}) => ({
  id: 'sess1', name: null, folderId: null, splitMode: 'auto',
  createdAt: 1, updatedAt: 10, metaUpdatedAt: 10,
  inputText: null, inputTextHash: null, sourceAudio: null, sourceAudioHash: null,
  sentences: [blankSentence({ id: 's1', text: 'hi', lang: 'en', now: 10 })],
  ...over,
});

/** A controllable clock: nothing runs until the test says so. */
function fakeTimers() {
  const queued = new Map();
  let next = 1;
  return {
    schedule: (fn, ms) => { const id = next++; queued.set(id, { fn, ms }); return id; },
    cancel: (id) => queued.delete(id),
    pending: () => queued.size,
    async fire() {
      const entries = [...queued.entries()];
      queued.clear();
      for (const [, { fn }] of entries) await fn();
    },
  };
}

function harness(over = {}) {
  const saves = [];
  const timers = fakeTimers();
  const store = createSessionStore(session());
  const errors = [];

  const autosave = createAutosave({
    store,
    db: { put: async () => {} },
    hash: {},
    saveRecord: async (entity, record) => {
      saves.push(record);
      return { ...record, inputTextHash: 'stamped' };
    },
    schedule: timers.schedule,
    cancel: timers.cancel,
    onError: (err) => errors.push(err),
    ...over,
  });

  return { store, autosave, saves, timers, errors };
}

test('a change schedules a save rather than writing immediately', async () => {
  const h = harness();
  h.store.apply((s) => ({ ...s, name: 'edited' }));

  assert.equal(h.saves.length, 0, 'nothing written yet');
  assert.equal(h.timers.pending(), 1);

  await h.timers.fire();
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].name, 'edited');
});

test('a burst of changes is coalesced into one save of the last state', async () => {
  const h = harness();
  h.store.apply((s) => ({ ...s, name: 'one' }));
  h.store.apply((s) => ({ ...s, name: 'two' }));
  h.store.apply((s) => ({ ...s, name: 'three' }));

  assert.equal(h.timers.pending(), 1, 'the earlier saves were cancelled');
  await h.timers.fire();

  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].name, 'three');
});

test('the stamped record is put back on screen, so hashes are not lost', async () => {
  const h = harness();
  h.store.apply((s) => ({ ...s, name: 'edited' }));
  await h.timers.fire();

  assert.equal(h.store.get().inputTextHash, 'stamped');
});

test('writing the stamped record back does not trigger another save', async () => {
  // Without this the save would loop: each write-back is a change, which
  // schedules a save, which writes back.
  const h = harness();
  h.store.apply((s) => ({ ...s, name: 'edited' }));
  await h.timers.fire();

  assert.equal(h.timers.pending(), 0, 'the write-back scheduled nothing');
  assert.equal(h.saves.length, 1);
});

test('a change landing during the save is not overwritten by the stamped record', async () => {
  let resolveSave;
  const h = harness({
    saveRecord: async (entity, record) => {
      await new Promise((resolve) => { resolveSave = resolve; });
      return { ...record, inputTextHash: 'stamped' };
    },
  });

  h.store.apply((s) => ({ ...s, name: 'first' }));
  const firing = h.timers.fire();

  // The user edits while the write is in flight.
  await Promise.resolve();
  h.store.apply((s) => updateSentence(s, 's1', { hidden: true }, 999));

  resolveSave();
  await firing;

  assert.equal(h.store.get().sentences[0].hidden, true, 'the newer edit survived');
  assert.equal(h.store.get().inputTextHash, null, 'the stale stamped copy was not written back');
});

test('a save requested while one is running does not interleave two writes', async () => {
  let running = 0;
  let overlapped = false;
  const recorded = [];
  const h = harness({
    saveRecord: async (entity, record) => {
      running++;
      if (running > 1) overlapped = true;
      recorded.push(record);
      await new Promise((resolve) => setTimeout(resolve, 0));
      running--;
      return record;
    },
  });

  h.store.apply((s) => ({ ...s, name: 'one' }));
  const first = h.timers.fire();
  h.store.apply((s) => ({ ...s, name: 'two' }));
  const second = h.timers.fire();
  await Promise.all([first, second]);

  assert.equal(overlapped, false, 'two writes of the same record never ran at once');
  assert.ok(recorded.length >= 1);
  assert.equal(recorded.at(-1).name, 'two', 'and the later state was the one written last');
});

test('flush: writes immediately, for a moment that must not be lost', async () => {
  const h = harness();
  h.store.apply((s) => ({ ...s, name: 'edited' }));

  await h.autosave.flush();

  assert.equal(h.saves.length, 1);
  assert.equal(h.timers.pending(), 0, 'and the scheduled save was cancelled, not left to fire again');
});

test('flush: with nothing pending it is harmless', async () => {
  const h = harness();
  await h.autosave.flush();
  assert.equal(h.saves.length, 1, 'writes the current state once');

  h.store.replace(null);
  await h.autosave.flush();
  assert.equal(h.saves.length, 1, 'and nothing at all when there is no session');
});

test('a failed save is reported rather than swallowed', async () => {
  // This is the write behind every edit: left silent, the user practises for an
  // hour with nothing being kept.
  const h = harness({ saveRecord: async () => { throw new Error('QuotaExceededError'); } });
  h.store.apply((s) => ({ ...s, name: 'edited' }));
  await h.timers.fire();

  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /Quota/);
});

test('a failed save does not stop later ones', async () => {
  let fail = true;
  const h = harness({
    saveRecord: async (entity, record) => {
      if (fail) throw new Error('once');
      h.saves.push(record);
      return record;
    },
  });

  h.store.apply((s) => ({ ...s, name: 'one' }));
  await h.timers.fire();
  fail = false;
  h.store.apply((s) => ({ ...s, name: 'two' }));
  await h.timers.fire();

  assert.equal(h.saves.at(-1).name, 'two');
});

test('stop: no further changes are saved', async () => {
  const h = harness();
  h.autosave.stop();
  h.store.apply((s) => ({ ...s, name: 'edited' }));

  assert.equal(h.timers.pending(), 0);
  await h.timers.fire();
  assert.equal(h.saves.length, 0);
});

test('reset: the next save re-hashes rather than trusting the previous record', async () => {
  const seen = [];
  const h = harness({
    saveRecord: async (entity, record, { previous }) => { seen.push(previous); return record; },
  });

  h.store.apply((s) => ({ ...s, name: 'one' }));
  await h.timers.fire();
  h.store.apply((s) => ({ ...s, name: 'two' }));
  await h.timers.fire();
  assert.ok(seen[1], 'the second save knew the first');

  h.autosave.reset();
  h.store.apply((s) => ({ ...s, name: 'three' }));
  await h.timers.fire();
  assert.equal(seen[2], null, 'after a reset it assumes nothing');
});
