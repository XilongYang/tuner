// Rearranging a list by hand: where a dragged row lands, and the keyboard path
// for anyone who cannot make the gesture.
//
// The pointer geometry is checked as a pure function and again in the browser
// suite, where boxes have real sizes; jsdom reports every box as zero-sized, so
// asserting a drag's landing place here would only be asserting that stub.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;

const { dragReorder, insertionIndex } = await import('../../js/ui/drag-list.js');

const box = (top, height = 10) => ({ top, height });

test('insertionIndex: the first row whose middle is below the pointer', () => {
  const boxes = [box(0), box(10), box(20)];
  assert.equal(insertionIndex(boxes, 2), 0, 'above the first row\'s middle');
  assert.equal(insertionIndex(boxes, 7), 1);
  assert.equal(insertionIndex(boxes, 17), 2);
  assert.equal(insertionIndex(boxes, 99), 3, 'past everything means the end');
});

test('insertionIndex: an empty list has one place to drop into', () => {
  assert.equal(insertionIndex([], 40), 0);
});

// ---- the list ----

let list;
let moves;

function build(ids = ['a', 'b', 'c']) {
  document.body.replaceChildren();
  list = document.createElement('div');
  document.body.append(list);
  for (const id of ids) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.id = id;
    const handle = document.createElement('button');
    handle.className = 'grip';
    row.append(handle);
    list.append(row);
  }
  moves = [];
  return dragReorder({
    list,
    rowSelector: '.row',
    handleSelector: '.grip',
    idOf: (row) => row.dataset.id,
    onMove: (move) => moves.push(move),
  });
}

const order = () => [...list.querySelectorAll('.row')].map((row) => row.dataset.id);
const grip = (id) => list.querySelector(`.row[data-id="${id}"] .grip`);
const key = (id, k) => grip(id).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));

beforeEach(() => build());

test('the keyboard moves a row one place, and says where it landed', () => {
  key('c', 'ArrowUp');

  assert.deepEqual(order(), ['a', 'c', 'b']);
  assert.deepEqual(moves, [{ id: 'c', beforeId: 'a', afterId: 'b' }]);
});

test('a row moved to the top reports no row above it', () => {
  key('b', 'ArrowUp');
  assert.deepEqual(moves, [{ id: 'b', beforeId: null, afterId: 'a' }]);
});

test('a row moved to the bottom reports no row below it', () => {
  key('b', 'ArrowDown');
  assert.deepEqual(order(), ['a', 'c', 'b']);
  assert.deepEqual(moves, [{ id: 'b', beforeId: 'c', afterId: null }]);
});

test('repeated presses walk the row along, rather than moving it once', () => {
  key('c', 'ArrowUp');
  key('c', 'ArrowUp');

  assert.deepEqual(order(), ['c', 'a', 'b']);
  assert.equal(moves.length, 2);
});

test('the ends of the list are the ends: nothing moves, nothing is reported', () => {
  key('a', 'ArrowUp');
  key('c', 'ArrowDown');

  assert.deepEqual(order(), ['a', 'b', 'c']);
  assert.deepEqual(moves, []);
});

test('arrow keys pressed anywhere but the handle are left alone', () => {
  // The rows carry buttons and fields of their own; a list that swallowed every
  // arrow key would take them from whatever has focus.
  const row = list.querySelector('.row[data-id="b"]');
  row.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));

  assert.deepEqual(order(), ['a', 'b', 'c']);
  assert.deepEqual(moves, []);
});

// ---- pointer ----

const pointer = (type, target, clientY) => target.dispatchEvent(
  new dom.window.MouseEvent(type, { bubbles: true, clientY, button: 0 }),
);

test('a press and release without movement is a click, not a move', () => {
  pointer('pointerdown', grip('b'), 50);
  pointer('pointerup', grip('b'), 50);

  assert.deepEqual(moves, [], 'the row never left its place, so there is nothing to report');
});

test('a press that barely moves is still a click', () => {
  pointer('pointerdown', grip('b'), 50);
  pointer('pointermove', grip('b'), 52);
  pointer('pointerup', grip('b'), 52);

  assert.deepEqual(moves, []);
});

test('a drag reports where the row ended up', () => {
  pointer('pointerdown', grip('a'), 0);
  pointer('pointermove', grip('a'), 40);
  pointer('pointerup', grip('a'), 40);

  assert.equal(moves.length, 1);
  assert.equal(moves[0].id, 'a');
});

test('a cancelled drag puts the row back and reports nothing', () => {
  pointer('pointerdown', grip('a'), 0);
  pointer('pointermove', grip('a'), 40);
  pointer('pointercancel', grip('a'), 40);

  assert.deepEqual(order(), ['a', 'b', 'c']);
  assert.deepEqual(moves, []);
});

test('Escape during a drag puts the row back', () => {
  pointer('pointerdown', grip('a'), 0);
  pointer('pointermove', grip('a'), 40);
  grip('a').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  assert.deepEqual(order(), ['a', 'b', 'c']);
  assert.deepEqual(moves, []);
});

test('cancel() abandons a drag the list is about to be redrawn under', () => {
  const reorder = build(['a', 'b', 'c']);
  pointer('pointerdown', grip('a'), 0);
  pointer('pointermove', grip('a'), 40);
  reorder.cancel();
  pointer('pointerup', grip('a'), 40);

  assert.deepEqual(order(), ['a', 'b', 'c']);
  assert.deepEqual(moves, [], 'a refresh mid-drag must not commit a position from the old list');
});

test('a drag started with a secondary button is not a drag', () => {
  const target = grip('a');
  target.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientY: 0, button: 2 }));
  pointer('pointermove', target, 40);
  pointer('pointerup', target, 40);

  assert.deepEqual(moves, []);
});

test('a press that is not on a handle does nothing', () => {
  const row = list.querySelector('.row[data-id="a"]');
  pointer('pointerdown', row, 0);
  pointer('pointermove', row, 40);
  pointer('pointerup', row, 40);

  assert.deepEqual(moves, []);
});
