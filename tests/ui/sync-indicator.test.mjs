// The header's sync indicator: the words for each state, and the element that
// renders them.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><div id="dot" hidden></div></body>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;

const { createSyncIndicator } = await import('../../js/ui/sync-indicator.js');
const {
  syncState, describeSync, syncProgress, syncTooltip, formatSyncTime, SYNC_LABELS,
} = await import('../../js/ui/sync-text.js');

const round = (over = {}) => ({
  ok: true, reason: null, uploaded: 0, downloaded: 0,
  written: 0, skipped: 0, deleted: 0, swept: 0, warnings: [], ...over,
});

let root;
beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  root.hidden = true;
  document.body.append(root);
});

// ---- which state a round is in ----

test('a finished round is synced; a failure is failed', () => {
  assert.equal(syncState(round()), 'synced');
  assert.equal(syncState(round({ ok: false, reason: 'Upload of "x" failed: HTTP 403' })), 'failed');
});

test('another device holding the lock is not this device failing', () => {
  // The round will happen, a little later. Red is for something being wrong.
  assert.equal(syncState(round({ ok: false, reason: 'locked' })), 'syncing');
  assert.equal(syncState(round({ ok: false, reason: 'locked-by:device-b' })), 'syncing');
});

test('no container means there is nothing to show at all', () => {
  assert.equal(syncState(round({ ok: false, reason: 'not-configured' })), 'off');
});

// ---- the words ----

test('exactly three words, so the header never has to grow', () => {
  assert.deepEqual(Object.values(SYNC_LABELS), ['Syncing', 'Synced', 'Sync Failed']);
});

test('progress counts when it knows the total, and says nothing false when it does not', () => {
  assert.equal(syncProgress({ done: 3, total: 7 }), 'Syncing 3 / 7…');
  assert.equal(syncProgress(null), 'Syncing…');
  assert.equal(syncProgress({ total: 0 }), 'Syncing…');
});

test('a finished round says what it did, and names the first warning in full', () => {
  assert.equal(describeSync(round({ uploaded: 2, downloaded: 1 })),
    'Sync complete — 2 uploaded, 1 downloaded.');
  assert.match(describeSync(round({ warnings: ['a: gone', 'b: gone'] })),
    /a: gone \(and 1 more\)$/);
});

test('the tooltip of a finished round is two lines: when, then what', () => {
  const at = Date.UTC(2026, 8, 21, 12, 0, 0);
  const text = syncTooltip({ state: 'synced', detail: 'Sync complete — 1 uploaded, 0 downloaded.', at });
  const [when, what] = text.split('\n');

  assert.match(when, /^Synced at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  assert.equal(what, '1 uploaded, 0 downloaded.', 'the prefix is already in the line above');
});

test('the timestamp keeps milliseconds, so two rounds a second apart differ', () => {
  const first = formatSyncTime(1_700_000_000_123);
  const second = formatSyncTime(1_700_000_000_456);
  assert.notEqual(first, second);
  assert.match(first, /\.123$/);
});

test('any other state shows its detail as it is', () => {
  assert.equal(syncTooltip({ state: 'failed', detail: 'Sync failed: HTTP 403' }), 'Sync failed: HTTP 403');
  assert.equal(syncTooltip({ state: 'syncing', detail: 'Syncing 1 / 4…' }), 'Syncing 1 / 4…');
});

// ---- the element ----

test('off hides it entirely: a grey dot would only invite a question', () => {
  const indicator = createSyncIndicator(root);
  indicator.set({ state: 'synced', detail: 'Sync complete — 0 uploaded, 0 downloaded.', at: Date.now() });
  assert.equal(root.hidden, false);

  indicator.set({ state: 'off' });

  assert.equal(root.hidden, true);
  assert.equal(root.dataset.state, undefined);
  assert.equal(root.querySelector('.sync-label').textContent, '');
});

test('each state paints the dot and names itself', () => {
  const indicator = createSyncIndicator(root);

  for (const [state, label] of Object.entries(SYNC_LABELS)) {
    indicator.set({ state, detail: 'whatever happened' });
    assert.equal(root.dataset.state, state, 'the colour comes from CSS keyed on this');
    assert.equal(root.querySelector('.sync-label').textContent, label);
  }
});

test('the detail is reachable without a pointer, and announced when it changes', () => {
  const indicator = createSyncIndicator(root);
  indicator.set({ state: 'failed', detail: 'Sync failed: HTTP 403' });

  assert.equal(root.tabIndex, 0, 'focusable, or the tooltip cannot be opened from a keyboard');
  assert.equal(root.querySelector('.sync-tooltip').getAttribute('role'), 'status');
  assert.equal(root.querySelector('.sync-tooltip').textContent, 'Sync failed: HTTP 403');
  assert.match(root.getAttribute('aria-label'), /^Sync Failed\. Sync failed: HTTP 403$/);
});

test('the dot itself is decoration: what it means is in the words beside it', () => {
  const indicator = createSyncIndicator(root);
  indicator.set({ state: 'syncing', detail: 'Syncing…' });
  assert.equal(root.querySelector('.sync-dot').getAttribute('aria-hidden'), 'true');
});
