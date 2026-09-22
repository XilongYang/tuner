// The deadline every request carries.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithTimeout, deadlineFor } from '../../js/cloud/http.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('a request that never settles is given up on, and cancelled', async () => {
  let aborted = false;
  globalThis.fetch = (url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      aborted = true;
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });

  await assert.rejects(fetchWithTimeout('https://example.test/', {}, 10), (err) => {
    assert.equal(err.timedOut, true, 'tagged, so the caller can tell a slow network from a refusal');
    assert.match(err.message, /timed out after/);
    return true;
  });
  assert.equal(aborted, true, 'the request itself is cancelled, not merely abandoned');
});

test('a response that arrives in time comes back untouched', async () => {
  globalThis.fetch = async () => new Response('hello', { status: 200 });

  const response = await fetchWithTimeout('https://example.test/', {}, 1000);

  assert.equal(await response.text(), 'hello');
});

test('a failure that is not the deadline is passed through as it is', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };

  await assert.rejects(fetchWithTimeout('https://example.test/', {}, 1000), (err) => {
    assert.equal(err.timedOut, undefined, 'not a timeout, and not dressed up as one');
    assert.match(err.message, /Failed to fetch/);
    return true;
  });
});

test('the timer is cleared either way, so a finished request holds nothing open', async () => {
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => { const id = realSetTimeout(fn, ms); timers.push(id); return id; };
  globalThis.clearTimeout = (id) => { timers.splice(timers.indexOf(id), 1); return realClearTimeout(id); };
  globalThis.fetch = async () => new Response('ok');

  try {
    await fetchWithTimeout('https://example.test/', {}, 5000);
    assert.deepEqual(timers, [], 'a pending timer would keep the process awake for its whole deadline');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test('deadlineFor: a bigger body buys more time, and nothing buys none', () => {
  assert.equal(deadlineFor(60_000, 0, 25), 60_000);
  assert.equal(deadlineFor(60_000, null, 25), 60_000);
  assert.equal(deadlineFor(60_000, 25_000, 25), 61_000, '25 KB at 25 bytes/ms is one more second');
  assert.ok(deadlineFor(60_000, 10_000_000, 25) > deadlineFor(60_000, 1_000_000, 25));
});
