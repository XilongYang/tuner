// Placing a session in the library, and moving it: the two things that are
// allowed to decide where a row sits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listOrdered, placeNew, moveSession } from '../../js/app/commands/order.js';
import { createSessionStore } from '../../js/app/store.js';

function fakeDb(sessions = []) {
  const rows = new Map(sessions.map((session) => [session.id, session]));
  const reads = [];
  return {
    reads,
    rows,
    listAll: async (name, opts = {}) => { reads.push({ name, opts }); return [...rows.values()]; },
    put: async (name, record) => { rows.set(record.id, record); },
  };
}

const session = (id, sortKey, over = {}) => ({
  id, sortKey, name: id, updatedAt: 1, metaUpdatedAt: 1, sentences: [], ...over,
});

const clock = () => 1000;
const ids = (db) => [...db.rows.values()].sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1)).map((s) => s.id);

test('listOrdered: the arrangement, and without reading the audio to get it', async () => {
  const db = fakeDb([session('c', 'w'), session('a', 'b'), session('b', 'i')]);
  assert.deepEqual((await listOrdered({ db })).map((s) => s.id), ['a', 'b', 'c']);
  assert.deepEqual(db.reads[0].opts, { content: false },
    'a list of names does not need every recording in the library read off disk');
});

test('placeNew: a session joining the library goes to the top', async () => {
  const db = fakeDb([session('old', 'i')]);
  const placed = await placeNew({ db, record: session('new', null) });

  assert.ok(placed.sortKey < 'i');
  assert.equal(placed.id, 'new');
});

test('placeNew: the first session in an empty library gets a place too', async () => {
  const placed = await placeNew({ db: fakeDb(), record: session('first', null) });
  assert.equal(typeof placed.sortKey, 'string');
});

test('placeNew: a session that already has a place keeps it, and costs no read', async () => {
  const db = fakeDb([session('a', 'i')]);
  const record = session('a', 'i');
  const placed = await placeNew({ db, record });

  assert.equal(placed, record, 'the same object back, so every later save is untouched');
  assert.deepEqual(db.reads, [], 'and the list is not read on saves after the first');
});

test('placeNew: repeated new sessions stack up, newest first', async () => {
  const db = fakeDb();
  for (const id of ['one', 'two', 'three']) {
    const placed = await placeNew({ db, record: session(id, null) });
    db.rows.set(id, placed);
  }
  assert.deepEqual(ids(db), ['three', 'two', 'one']);
});

// ---- moving ----

test('moveSession: between two rows', async () => {
  const db = fakeDb([session('a', 'b'), session('b', 'i'), session('c', 'w')]);
  const outcome = await moveSession({ db, clock, sessionId: 'c', beforeId: 'a', afterId: 'b' });

  assert.equal(outcome.ok, true);
  assert.deepEqual(ids(db), ['a', 'c', 'b']);
});

test('moveSession: to the top and to the bottom', async () => {
  const db = fakeDb([session('a', 'b'), session('b', 'i'), session('c', 'w')]);

  await moveSession({ db, clock, sessionId: 'c', beforeId: null, afterId: 'a' });
  assert.deepEqual(ids(db), ['c', 'a', 'b']);

  await moveSession({ db, clock, sessionId: 'c', beforeId: 'b', afterId: null });
  assert.deepEqual(ids(db), ['a', 'b', 'c']);
});

test('moveSession: a move is a write to one record and no others', async () => {
  const db = fakeDb([session('a', 'b'), session('b', 'i'), session('c', 'w')]);
  const before = { a: db.rows.get('a'), b: db.rows.get('b') };

  await moveSession({ db, clock, sessionId: 'c', beforeId: null, afterId: 'a' });

  assert.equal(db.rows.get('a'), before.a, 'an index-based order would have rewritten every row below');
  assert.equal(db.rows.get('b'), before.b);
});

test('moveSession: the moved row\'s own clock is bumped, so the move wins the merge', async () => {
  const db = fakeDb([session('a', 'b'), session('b', 'i')]);
  await moveSession({ db, clock, sessionId: 'b', beforeId: null, afterId: 'a' });

  const moved = db.rows.get('b');
  assert.equal(moved.metaUpdatedAt, 1000);
  assert.equal(moved.updatedAt, 1000);
});

test('moveSession: dropping a row back where it already was writes nothing', async () => {
  const db = fakeDb([session('a', 'b'), session('b', 'i'), session('c', 'w')]);
  const untouched = db.rows.get('b');

  const outcome = await moveSession({ db, clock, sessionId: 'b', beforeId: 'a', afterId: 'c' });

  assert.equal(outcome.ok, true);
  assert.equal(db.rows.get('b'), untouched);
});

test('moveSession: a neighbour that is no longer there is refused, not guessed at', async () => {
  // The list on screen can be a sync behind: the row that was above the drop
  // may have been deleted on another device. Landing the row "somewhere near
  // there" would be a position the user never pointed at.
  const db = fakeDb([session('a', 'b'), session('b', 'i')]);
  const outcome = await moveSession({ db, clock, sessionId: 'b', beforeId: 'gone', afterId: null });

  assert.deepEqual(outcome, { ok: false, reason: 'stale' });
  assert.equal(db.rows.get('b').sortKey, 'i', 'and nothing moved');
});

test('moveSession: neighbours that have swapped places since the list was drawn are refused', async () => {
  const db = fakeDb([session('a', 'w'), session('b', 'i'), session('c', 'z')]);
  const outcome = await moveSession({ db, clock, sessionId: 'c', beforeId: 'a', afterId: 'b' });

  assert.deepEqual(outcome, { ok: false, reason: 'stale' });
});

test('moveSession: a neighbour whose key cannot be subdivided is refused, not guessed at', async () => {
  // Such a key cannot come from this device (see model/order.js), so it means
  // the list is not the one this move was aimed at.
  const db = fakeDb([session('a', 'b0'), session('b', 'i')]);
  const outcome = await moveSession({ db, clock, sessionId: 'b', beforeId: null, afterId: 'a' });

  assert.deepEqual(outcome, { ok: false, reason: 'stale' });
  assert.equal(db.rows.get('b').sortKey, 'i', 'and nothing moved');
});

test('moveSession: the session on screen is moved too, or the next save undoes it', async () => {
  // The copy in the store is what autosave writes. Left with the old position,
  // it goes back over this one at the next keystroke -- and since that write is
  // the newer of the two, the other devices learn the move never happened.
  const db = fakeDb([session('a', 'b'), session('b', 'i')]);
  const store = createSessionStore({ ...db.rows.get('b') });

  await moveSession({ db, clock, store, sessionId: 'b', beforeId: null, afterId: 'a' });

  assert.equal(store.get().sortKey, db.rows.get('b').sortKey, 'the same key on screen as in storage');
  assert.equal(store.get().metaUpdatedAt, db.rows.get('b').metaUpdatedAt,
    'and the same moment, so neither copy can outrank the other later');
});

test('moveSession: a session other than the one on screen leaves the screen alone', async () => {
  const db = fakeDb([session('a', 'b'), session('b', 'i')]);
  const store = createSessionStore({ ...db.rows.get('a') });
  const before = store.get();

  await moveSession({ db, clock, store, sessionId: 'b', beforeId: null, afterId: 'a' });

  assert.equal(store.get(), before);
});

test('moveSession: a session that is gone is refused', async () => {
  const outcome = await moveSession({ db: fakeDb(), clock, sessionId: 'nope', beforeId: null, afterId: null });
  assert.deepEqual(outcome, { ok: false, reason: 'not-found' });
});
