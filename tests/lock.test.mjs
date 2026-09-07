import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLockStale, lockAgeMs, LOCK_STALE_MS, BLOB_LOCK_PATH } from '../js/sync/lock.js';

test('lock.js: BLOB_LOCK_PATH and LOCK_STALE_MS match the spec (10 minutes)', () => {
  assert.equal(BLOB_LOCK_PATH, 'tuner/sync.lock');
  assert.equal(LOCK_STALE_MS, 10 * 60 * 1000);
});

test('isLockStale: a lock acquired just now is not stale', () => {
  const now = 1_000_000_000;
  const lock = { deviceId: 'abc123', acquiredAt: now };
  assert.equal(isLockStale(lock, now), false);
});

test('isLockStale: a lock just under the timeout is not stale', () => {
  const now = 1_000_000_000;
  const lock = { deviceId: 'abc123', acquiredAt: now - (LOCK_STALE_MS - 1) };
  assert.equal(isLockStale(lock, now), false);
});

test('isLockStale: a lock past the timeout is stale', () => {
  const now = 1_000_000_000;
  const lock = { deviceId: 'abc123', acquiredAt: now - (LOCK_STALE_MS + 1) };
  assert.equal(isLockStale(lock, now), true);
});

test('isLockStale: exactly at the timeout boundary is not yet stale (strictly greater-than)', () => {
  const now = 1_000_000_000;
  const lock = { deviceId: 'abc123', acquiredAt: now - LOCK_STALE_MS };
  assert.equal(isLockStale(lock, now), false);
});

test('isLockStale: missing/malformed lock data is treated as stale', () => {
  const now = 1_000_000_000;
  assert.equal(isLockStale(null, now), true);
  assert.equal(isLockStale(undefined, now), true);
  assert.equal(isLockStale({}, now), true);
  assert.equal(isLockStale({ deviceId: 'x' }, now), true);
});

test('isLockStale: defaults `now` to the current clock when omitted', () => {
  // A lock acquired far in the future relative to Date.now() should never
  // read as stale; one from far in the past always should.
  assert.equal(isLockStale({ acquiredAt: Date.now() + 60_000 }), false);
  assert.equal(isLockStale({ acquiredAt: Date.now() - (LOCK_STALE_MS * 10) }), true);
});

test('lockAgeMs: reports elapsed time since acquiredAt', () => {
  const now = 1_000_000_000;
  assert.equal(lockAgeMs({ acquiredAt: now - 5000 }, now), 5000);
  assert.equal(lockAgeMs({ acquiredAt: now }, now), 0);
});
