import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;

const { el, button, readNumber, writeNumber, reconcile } = await import('../../js/ui/dom.js');

let container;
beforeEach(() => {
  document.body.innerHTML = '<div id="list"></div>';
  container = document.getElementById('list');
});

test('el: assigns class, text, dataset and listeners', () => {
  let clicked = 0;
  const node = el('div', { class: 'row', text: 'hi', dataset: { id: 'a' }, on: { click: () => { clicked++; } } });
  node.dispatchEvent(new dom.window.Event('click'));
  assert.equal(node.className, 'row');
  assert.equal(node.textContent, 'hi');
  assert.equal(node.dataset.id, 'a');
  assert.equal(clicked, 1);
});

test('el: skips null props instead of writing "null" into the DOM', () => {
  const node = el('div', { class: 'x', title: null, text: undefined });
  assert.equal(node.hasAttribute('title'), false);
  assert.equal(node.textContent, '');
});

test('el: appends children, ignoring the falsy ones a conditional produces', () => {
  const node = el('div', {}, ['a', false, null, el('span', { text: 'b' })]);
  assert.equal(node.textContent, 'ab');
  assert.equal(node.children.length, 1);
});

test('button: defaults to type=button so it never submits a form', () => {
  assert.equal(button({ text: 'Go' }).type, 'button');
});

test('button: wires onClick and carries hidden/disabled through', () => {
  let n = 0;
  const b = button({ text: 'Go', hidden: true, disabled: true, onClick: () => { n++; } });
  b.dispatchEvent(new dom.window.Event('click'));
  assert.equal(n, 1);
  assert.equal(b.hidden, true);
  assert.equal(b.disabled, true);
});

test('readNumber: an empty or absent attribute is null, NOT 0', () => {
  // The coercion that silently destroyed audio: Number('') === 0, which
  // downstream arithmetic accepted as "the very start of the file".
  const node = el('div', { dataset: { ms: '' } });
  assert.equal(readNumber(node, 'ms'), null);
  assert.equal(readNumber(el('div'), 'ms'), null);
  assert.equal(readNumber(null, 'ms'), null);
});

test('readNumber: a real 0 survives as 0', () => {
  assert.equal(readNumber(el('div', { dataset: { ms: '0' } }), 'ms'), 0);
});

test('readNumber: junk is null rather than NaN leaking into arithmetic', () => {
  assert.equal(readNumber(el('div', { dataset: { ms: 'abc' } }), 'ms'), null);
});

test('writeNumber/readNumber round-trip null and 0 distinctly', () => {
  const node = el('div');
  writeNumber(node, 'ms', null);
  assert.equal(readNumber(node, 'ms'), null);
  writeNumber(node, 'ms', 0);
  assert.equal(readNumber(node, 'ms'), 0);
});

const rows = (ids) => ids.map((id) => ({ id, label: id.toUpperCase() }));
const spec = {
  key: (item) => item.id,
  create: (item) => el('div', { class: 'row', text: item.label }),
  update: (node, item) => { node.textContent = item.label; },
};

test('reconcile: creates rows for a first render', () => {
  const result = reconcile(container, rows(['a', 'b']), spec);
  assert.deepEqual(result.created, ['a', 'b']);
  assert.deepEqual([...container.children].map((c) => c.textContent), ['A', 'B']);
});

test('reconcile: a surviving row is the SAME element, so its live state is untouched', () => {
  reconcile(container, rows(['a', 'b']), spec);
  const rowA = container.children[0];
  // Anything living in the row: a listener, a class the user's interaction set,
  // focus, a MediaRecorder held in a closure. Here: a marker property.
  rowA.dataset.selected = 'yes';
  rowA.inFlightRecording = 'RECORDER';

  reconcile(container, rows(['a', 'b']), spec);

  assert.equal(container.children[0], rowA, 'not replaced');
  assert.equal(container.children[0].dataset.selected, 'yes');
  assert.equal(container.children[0].inFlightRecording, 'RECORDER');
});

test('reconcile: a repaint mid-selection keeps the selection -- the bug a full rebuild caused', () => {
  reconcile(container, rows(['a', 'b', 'c']), spec);
  container.children[1].classList.add('is-selected');

  // A background sync repaints with the same data.
  reconcile(container, rows(['a', 'b', 'c']), spec);

  assert.deepEqual(
    [...container.children].map((c) => c.classList.contains('is-selected')),
    [false, true, false],
  );
});

test('reconcile: removes rows whose key is gone and reports them', () => {
  reconcile(container, rows(['a', 'b', 'c']), spec);
  const result = reconcile(container, rows(['a', 'c']), spec);
  assert.deepEqual(result.removed, ['b']);
  assert.deepEqual([...container.children].map((c) => c.textContent), ['A', 'C']);
});

test('reconcile: reorders by moving existing elements rather than rebuilding them', () => {
  reconcile(container, rows(['a', 'b', 'c']), spec);
  const [rowA, rowB, rowC] = [...container.children];

  reconcile(container, rows(['c', 'a', 'b']), spec);

  assert.deepEqual([...container.children], [rowC, rowA, rowB]);
});

test('reconcile: a split -- one row replaced by two -- keeps the untouched neighbours', () => {
  reconcile(container, rows(['a', 'b', 'c']), spec);
  const rowA = container.children[0];
  const rowC = container.children[2];

  const result = reconcile(container, rows(['a', 'b1', 'b2', 'c']), spec);

  assert.deepEqual(result.created, ['b1', 'b2']);
  assert.deepEqual(result.removed, ['b']);
  assert.equal(container.children[0], rowA);
  assert.equal(container.children[3], rowC);
});

test('reconcile: update patches content in place', () => {
  reconcile(container, rows(['a']), spec);
  const rowA = container.children[0];
  reconcile(container, [{ id: 'a', label: 'CHANGED' }], spec);
  assert.equal(container.children[0], rowA);
  assert.equal(rowA.textContent, 'CHANGED');
});

test('reconcile: works with no update function at all', () => {
  reconcile(container, rows(['a']), { key: spec.key, create: spec.create });
  assert.equal(container.children.length, 1);
});

test('reconcile: an empty list clears the container', () => {
  reconcile(container, rows(['a', 'b']), spec);
  const result = reconcile(container, [], spec);
  assert.deepEqual(result.removed, ['a', 'b']);
  assert.equal(container.children.length, 0);
});

test('reconcile: duplicate keys fail loudly instead of silently dropping a row', () => {
  assert.throws(() => reconcile(container, rows(['a', 'a']), spec), /duplicate key a/);
});

test('reconcile: foreign unkeyed children are cleared out, not left to drift', () => {
  container.append(el('p', { text: 'placeholder' }));
  reconcile(container, rows(['a']), spec);
  assert.deepEqual([...container.children].map((c) => c.tagName), ['DIV']);
});

test('reconcile: an update that returns a new element swaps it in, keyed, in place', () => {
  reconcile(container, rows(['a', 'b', 'c']), spec);
  const rebuild = {
    ...spec,
    update: (_node, item) => el('div', { class: 'row rebuilt', text: item.label }),
  };

  reconcile(container, rows(['a', 'b', 'c']), rebuild);

  assert.equal(container.children.length, 3, 'one row per key, not two');
  assert.deepEqual([...container.children].map((c) => c.textContent), ['A', 'B', 'C']);
  assert.ok([...container.children].every((c) => c.classList.contains('rebuilt')), 'the returned rows are what is shown');
});

test('reconcile: a rebuilding list stays at one row per key however often it is repainted', () => {
  // The bug this guards: the library rebuilt each row by calling
  // element.replaceWith() and returning nothing, so every session was listed
  // twice -- and deleting either copy made both vanish, because there was only
  // ever one record.
  const rebuild = { ...spec, update: (_node, item) => el('div', { class: 'row', text: item.label }) };
  for (let i = 0; i < 4; i++) reconcile(container, rows(['a', 'b']), rebuild);

  assert.equal(container.children.length, 2);
});

test('reconcile: an update that replaces the row itself is refused rather than duplicating it', () => {
  reconcile(container, rows(['a']), spec);
  const selfReplacing = {
    ...spec,
    update: (node, item) => { node.replaceWith(el('div', { class: 'row', text: item.label })); },
  };

  assert.throws(
    () => reconcile(container, rows(['a']), selfReplacing),
    /update detached the row for a/,
  );
});
