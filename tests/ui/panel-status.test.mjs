// The status line's lifetime. Reported as "这东西生命周期是不是有问题？一直显示":
// "Session deleted." stayed on screen for as long as the page lived, and came
// back with the panel the next time it was opened.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;

const { panelStatus, INFO_MS } = await import('../../js/ui/panel-status.js');

// A hand-wound clock: the point is which messages expire, not how long that
// takes, and a test that waits five seconds to find out is a test nobody runs.
function clock() {
  let next = 1;
  const pending = new Map();
  return {
    setTimer: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimer: (id) => pending.delete(id),
    pendingCount: () => pending.size,
    advance() {
      for (const [id, { fn }] of [...pending]) { pending.delete(id); fn(); }
    },
  };
}

const make = () => { const c = clock(); return { c, status: panelStatus(c) }; };

let harness;
beforeEach(() => { harness = make(); });

test('an acknowledgement is shown, then goes on its own', () => {
  const { c, status } = harness;
  status.say('Session deleted.');
  assert.equal(status.node.textContent, 'Session deleted.');
  assert.equal(status.node.hidden, false);

  c.advance();
  assert.equal(status.node.textContent, '');
  assert.equal(status.node.hidden, true);
});

test('an error stays: the reader may not have been looking when it arrived', () => {
  const { c, status } = harness;
  status.say('Could not save: this browser is refusing to store settings.', 'error');

  c.advance();
  assert.match(status.node.textContent, /refusing to store settings/);
  assert.equal(status.node.dataset.kind, 'error');
});

test('a busy line stays until its own outcome replaces it', () => {
  const { c, status } = harness;
  status.say('Syncing…', 'busy');

  c.advance();
  assert.equal(status.node.textContent, 'Syncing…', 'a progress line that times out is a lie');

  status.say('2 uploaded, 1 downloaded.');
  assert.match(status.node.textContent, /2 uploaded/);
});

test('a new message takes the line over, expiry and all', () => {
  const { c, status } = harness;
  status.say('Session deleted.');
  status.say('Word deleted.');
  assert.equal(c.pendingCount(), 1, 'the first message\'s expiry would have cut the second one short');

  c.advance();
  assert.equal(status.node.textContent, '');
});

test('an error that follows an acknowledgement is not taken down by its timer', () => {
  const { c, status } = harness;
  status.say('Session deleted.');
  status.say('Could not delete it: HTTP 500', 'error');

  c.advance();
  assert.match(status.node.textContent, /HTTP 500/);
});

test('clear takes the line down whatever it says, and cancels nothing later', () => {
  const { c, status } = harness;
  status.say('Sync failed: HTTP 500', 'error');
  status.clear();

  assert.equal(status.node.textContent, '');
  assert.equal(status.node.hidden, true);
  assert.equal(c.pendingCount(), 0);
});

test('saying nothing hides the line and starts no timer', () => {
  const { c, status } = harness;
  status.say('');
  assert.equal(status.node.hidden, true);
  assert.equal(c.pendingCount(), 0);
});

test('the default expiry is a real duration, not zero', () => {
  // Guards the wiring rather than the number: a 0 here would make every
  // acknowledgement flash and vanish before it could be read.
  assert.ok(INFO_MS >= 2000);
});
