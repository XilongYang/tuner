// The list's arrangement: keys that can always be subdivided, and a comparator
// that two devices agree on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { between, keyBefore, keyAfter, byOrder, inOrder, keyForMove } from '../../js/model/order.js';

// A run of keys, each below the last. Used here to build fixtures of a given
// size; the app never mints a run -- it places one row at a time.
const initialKeys = (count, { after = null } = {}) => {
  const keys = [];
  let previous = after;
  for (let i = 0; i < count; i += 1) {
    previous = between(previous, null);
    keys.push(previous);
  }
  return keys;
};

const sorted = (keys) => keys.every((key, i) => i === 0 || keys[i - 1] < key);

test('between: an unbounded list gets a key in the middle of the range', () => {
  const key = between(null, null);
  assert.ok(key > '0' && key < 'z', `${key} leaves room on both sides`);
});

test('between: a key lands strictly between its neighbours', () => {
  const key = between('a', 'b');
  assert.ok('a' < key && key < 'b', `${key} is between a and b`);
});

test('between: room is always found, however tight the gap', () => {
  // The case an index-based order cannot answer: squeezing rows into the same
  // place over and over. Here the keys simply get longer.
  let lower = 'a';
  const upper = 'b';
  for (let i = 0; i < 200; i += 1) {
    const key = between(lower, upper);
    assert.ok(lower < key && key < upper, `${key} between ${lower} and ${upper}`);
    lower = key;
  }
});

test('between: 3000 inserts at random positions never break the order', () => {
  const keys = initialKeys(3);
  for (let i = 0; i < 3000; i += 1) {
    const at = Math.floor(Math.random() * (keys.length + 1));
    keys.splice(at, 0, between(keys[at - 1] ?? null, keys[at] ?? null));
  }
  assert.ok(sorted(keys));
  assert.ok(Math.max(...keys.map((key) => key.length)) < 12, 'and the keys stay short');
});

test('between: neighbours in the wrong order are a bug, and say so', () => {
  assert.throws(() => between('b', 'a'), /out of sequence/);
  assert.throws(() => between('a', 'a'), /out of sequence/);
});

test('between: a key it cannot subdivide is refused rather than answered wrongly', () => {
  // A key ending in the lowest digit has no room below it at that length, and
  // the subdivision would return a key past the upper bound. Nothing here
  // produces such a key, so one can only arrive from another device or a
  // hand-edited record -- and a refusal is recoverable where a silently
  // misplaced row is not.
  assert.throws(() => between('a', 'a0'), /cannot be subdivided/);
  assert.throws(() => between('a0', 'b'), /cannot be subdivided/);
  assert.throws(() => between('a0', null), /cannot be subdivided/);
});

test('between: every key it generates can itself be subdivided', () => {
  // Which is what makes the refusal above unreachable in normal use.
  const keys = initialKeys(40);
  for (let i = 0; i < 2000; i += 1) {
    const at = Math.floor(Math.random() * (keys.length + 1));
    keys.splice(at, 0, between(keys[at - 1] ?? null, keys[at] ?? null));
  }
  assert.ok(keys.every((key) => !key.endsWith('0')));
});

test('keyBefore and keyAfter place a row at the ends of a list', () => {
  const keys = ['b', 'i', 'w'];
  assert.ok(keyBefore(keys) < 'b');
  assert.ok(keyAfter(keys) > 'w');
  assert.equal(typeof keyBefore([]), 'string', 'an empty list has ends too');
});

test('keyForMove: the top, the bottom and the middle are the same call', () => {
  assert.ok(keyForMove({ before: null, after: 'i' }) < 'i');
  assert.ok(keyForMove({ before: 'i', after: null }) > 'i');
  const middle = keyForMove({ before: 'i', after: 'w' });
  assert.ok(middle > 'i' && middle < 'w');
});

// ---- reading the list ----

const row = (id, sortKey) => ({ id, sortKey });

test('inOrder: ascending by key, and nothing else is consulted', () => {
  const rows = [
    { id: 'c', sortKey: 'w', updatedAt: 9999, name: 'newest' },
    { id: 'a', sortKey: 'b', updatedAt: 1 },
    { id: 'b', sortKey: 'i', updatedAt: 500 },
  ];
  assert.deepEqual(inOrder(rows).map((r) => r.id), ['a', 'b', 'c']);
});

test('inOrder: the argument is left alone', () => {
  const rows = [row('c', 'w'), row('a', 'b')];
  inOrder(rows);
  assert.deepEqual(rows.map((r) => r.id), ['c', 'a']);
});

test('byOrder: two rows given the same key are still shown the same way round everywhere', () => {
  // Two devices that both put a new session at the top compute the same key --
  // the computation is deterministic and they are looking at the same list. The
  // id decides, so both devices show the same order as each other.
  const same = [row('zeta', 'i'), row('alpha', 'i')];
  assert.deepEqual(inOrder(same).map((r) => r.id), ['alpha', 'zeta']);
  assert.deepEqual(inOrder([...same].reverse()).map((r) => r.id), ['alpha', 'zeta']);
});

test('byOrder: a row with no key yet sorts to the bottom, not the top', () => {
  const rows = [row('none', null), row('placed', 'w')];
  assert.deepEqual(inOrder(rows).map((r) => r.id), ['placed', 'none']);
  assert.equal(byOrder(row('a', null), row('b', null)), -1, 'and two of them still have an order');
});

// ---- the one-time stamping ----

