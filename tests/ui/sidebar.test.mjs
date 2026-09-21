// The one sidebar and its tab row: which view is showing, and what each panel
// is told about it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;

const { createSidebar } = await import('../../js/ui/panels/sidebar.js');

/** A panel that records what it was told, the way the real ones are told it. */
function fakePanel(name) {
  const calls = [];
  return {
    name,
    calls,
    setOpen: (open, which) => calls.push(which === undefined ? open : [open, which]),
    get state() { return calls.at(-1); },
  };
}

let container;
let tabs;
let library;
let settings;
let changes;

function build() {
  document.body.replaceChildren();
  container = document.createElement('aside');
  tabs = document.createElement('div');
  container.append(tabs);
  document.body.append(container);
  library = fakePanel('library');
  settings = fakePanel('settings');
  changes = [];

  return createSidebar({
    container,
    tabs,
    views: [
      { name: 'sessions', label: 'Sessions', panel: library, tab: 'sessions' },
      { name: 'vocab', label: 'Vocabulary', panel: library, tab: 'vocab' },
      { name: 'settings', label: 'Settings', panel: settings },
    ],
    onChange: (open) => changes.push(open),
  });
}

const tabNamed = (label) => [...tabs.querySelectorAll('.panel-tab')].find((btn) => btn.textContent === label);
const labels = () => [...tabs.querySelectorAll('.panel-tab')].map((btn) => btn.textContent);
const active = () => [...tabs.querySelectorAll('.panel-tab')]
  .filter((btn) => btn.classList.contains('is-active'))
  .map((btn) => btn.textContent);

let sidebar;
beforeEach(() => { sidebar = build(); });

test('every view gets a tab, in the order given', () => {
  assert.deepEqual(labels(), ['Sessions', 'Vocabulary', 'Settings']);
});

test('nothing is open to begin with, and the sidebar is not on screen', () => {
  assert.equal(container.hidden, true);
  assert.deepEqual(active(), []);
});

test('a tab opens its view and marks itself', () => {
  tabNamed('Settings').click();

  assert.equal(container.hidden, false);
  assert.deepEqual(active(), ['Settings']);
  assert.equal(settings.state, true);
  assert.equal(library.state, false);
});

test('a view is told which of its lists to show', () => {
  tabNamed('Vocabulary').click();
  assert.deepEqual(library.state, [true, 'vocab']);

  tabNamed('Sessions').click();
  assert.deepEqual(library.state, [true, 'sessions']);
});

test('two tabs sharing one panel leave it open, whichever order the views are in', () => {
  // The bug this guards: closing runs first and opening second. A loop that
  // opened the new view before closing the old one would shut the panel that
  // both of them are, and it would depend on nothing but the listing order.
  tabNamed('Sessions').click();
  tabNamed('Vocabulary').click();

  assert.deepEqual(library.state, [true, 'vocab']);
  assert.equal(container.hidden, false);
});

test('opening one view closes the others', () => {
  tabNamed('Settings').click();
  tabNamed('Sessions').click();

  assert.equal(settings.state, false);
  assert.deepEqual(library.state, [true, 'sessions']);
  assert.deepEqual(active(), ['Sessions']);
});

test('toggle closes the view that is already showing', () => {
  sidebar.toggle('settings');
  assert.equal(container.hidden, false);

  sidebar.toggle('settings');
  assert.equal(container.hidden, true);
  assert.equal(settings.state, false);
  assert.deepEqual(active(), []);
});

test('close puts the whole sidebar away, whatever was in it', () => {
  tabNamed('Vocabulary').click();
  sidebar.close();

  assert.equal(container.hidden, true);
  assert.equal(library.state, false);
  assert.equal(sidebar.current(), null);
});

test('what is open is reported, for the header button that opens it', () => {
  assert.deepEqual(changes, [null], 'and said once at the start, so the button begins correct');

  tabNamed('Vocabulary').click();
  assert.equal(sidebar.current(), 'vocab');
  assert.equal(sidebar.isOpen('vocab'), true);
  assert.deepEqual(changes.at(-1), 'vocab');

  sidebar.close();
  assert.deepEqual(changes.at(-1), null);
});

test('the tabs of a closed sidebar are not in the tab order', () => {
  // They are on screen only when it is open; a tab stop that focuses nothing
  // visible is a dead key press.
  assert.deepEqual([...tabs.querySelectorAll('.panel-tab')].map((btn) => btn.tabIndex), [0, 0, 0]);

  tabNamed('Vocabulary').click();
  assert.deepEqual([...tabs.querySelectorAll('.panel-tab')].map((btn) => btn.tabIndex), [-1, 0, -1],
    'and while it is open, the showing tab is the way back in');
});

test('each tab says whether it is the selected one, in the markup', () => {
  tabNamed('Settings').click();
  assert.equal(tabNamed('Settings').getAttribute('aria-selected'), 'true');
  assert.equal(tabNamed('Sessions').getAttribute('aria-selected'), 'false');
});
