import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutosave } from '../../js/app/autosave.js';
import { createSessionStore } from '../../js/app/store.js';
import { saveRecord } from '../../js/app/persist.js';
import { placeNew } from '../../js/app/commands/order.js';
import { blankSentence, updateSentence } from '../../js/model/session.js';
import { hashBlob, hashString, hashJson, materializeBlob } from '../../js/platform/hash.js';

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

test('a session with nothing in it is not stored at all', async () => {
  // A blank session is the resting state -- one exists at startup and after
  // every New session. Storing them fills the library with rows that have
  // nothing to open.
  const h = harness();
  h.store.replace(session({ id: 'blank', sentences: [] }));
  await h.timers.fire();

  assert.deepEqual(h.saves, []);
});

test('it is stored as soon as something is split into it', async () => {
  const h = harness();
  h.store.replace(session({ id: 'blank', sentences: [] }));
  await h.timers.fire();

  h.store.replace(session({ id: 'blank' }));
  await h.timers.fire();

  assert.deepEqual(h.saves.map((record) => record.id), ['blank']);
});

test('an import is stored while it is still only a source file', async () => {
  const h = harness();
  h.store.replace(session({ id: 'imported', sentences: [], sourceAudio: 'FILE', splitMode: 'audio' }));
  await h.timers.fire();

  assert.deepEqual(h.saves.map((record) => record.id), ['imported']);
});

test('flush does not write a blank session either', async () => {
  const h = harness();
  h.store.replace(session({ id: 'blank', sentences: [] }));
  await h.autosave.flush();

  assert.deepEqual(h.saves, []);
});

test('a record gets its last look before storage, and what comes back is what is stored', async () => {
  // How a session joins the library list: it is given a place on the way to
  // the first write (app/commands/order.js). Autosave itself has no opinion
  // about the list -- it just hands the record over on its way past.
  const h = harness({ prepare: (record) => ({ ...record, sortKey: 'i' }) });
  h.store.apply((s) => ({ ...s, name: 'edited' }));
  await h.timers.fire();

  assert.equal(h.saves.at(-1).sortKey, 'i');
  assert.equal(h.store.get().sortKey, 'i', 'and the screen has it too, so the next save is not a second placement');
});

test('the write-back keeps every content value the same object the screen already holds', async () => {
  // Through the real path, as main.js wires it: saveRecord, real hashing, and
  // placeNew as the last look. A score in flight tells a retake from the take
  // it scored by identity (`now.recording !== recording`), so a save that
  // handed the screen a copy of the Blob would have every score that landed
  // after an autosave discarded as superseded -- with nothing on screen to
  // explain it.
  const take = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
  const held = new Set();
  const db = {
    listAll: async () => [],
    storedContentHashes: async (hashes) => new Set(hashes.filter((h) => held.has(h))),
    putRecord: async (_entity, _record, entries) => { for (const e of entries) held.add(e.hash); },
  };
  const h = harness({
    db,
    hash: { hashBlob, hashString, hashJson, materializeBlob },
    saveRecord,
    prepare: (record) => placeNew({ db, record }),
  });
  h.store.apply((s) => updateSentence(s, 's1', { recording: take, recordingHash: null }, 20), 'recording');
  const before = h.store.get();

  await h.autosave.flush();

  const after = h.store.get();
  assert.notEqual(after, before, 'the stamped record is on screen');
  assert.equal(after.sentences[0].recordingHash, await hashBlob(take), 'with its hash');
  assert.equal(after.sortKey !== null, true, 'and its place in the library');
  assert.equal(after.sentences[0].recording, take, 'around the very Blob the screen already held');
});

test('flush waits for a change that arrived while a save was running', async () => {
  // Otherwise flush returns having written the state from before that change,
  // and the caller -- switching sessions, or closing the page -- moves on. The
  // edit is then written over, or not at all.
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const saves = [];
  const timers = fakeTimers();
  const store = createSessionStore(session());
  let first = true;

  const autosave = createAutosave({
    store,
    db: { put: async () => {} },
    hash: {},
    saveRecord: async (entity, record) => {
      saves.push(record.name);
      if (first) { first = false; await slow; }
      return record;
    },
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  store.apply((s) => ({ ...s, name: 'first' }));
  const running = timers.fire();          // the save starts and blocks
  await Promise.resolve();

  store.apply((s) => ({ ...s, name: 'second' }));  // arrives mid-save
  const flushed = autosave.flush();

  release();
  await flushed;

  // Asserted before awaiting the save loop itself: the point is that *flush*
  // waited, not that everything eventually got written.
  assert.deepEqual(saves, ['first', 'second'], 'both, and the second before flush resolved');
  await running;
});
