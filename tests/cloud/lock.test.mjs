import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquire, release, forceRelease, status, isLockStale, lockAgeMs, LOCK_PATH, LOCK_STALE_MS,
} from '../../js/cloud/sync/lock.js';
import { fakeContainer } from './fake-container.mjs';

const at = (ms) => () => ms;

test('isLockStale: a fresh lock is held, an old one is abandoned', () => {
  assert.equal(isLockStale({ acquiredAt: 1000 }, 1000 + LOCK_STALE_MS - 1), false);
  assert.equal(isLockStale({ acquiredAt: 1000 }, 1000 + LOCK_STALE_MS + 1), true);
});

test('isLockStale: a malformed record counts as abandoned rather than blocking sync forever', () => {
  assert.equal(isLockStale(null, 0), true);
  assert.equal(isLockStale({}, 0), true);
  assert.equal(isLockStale({ acquiredAt: 'soon' }, 0), true);
});

test('lockAgeMs: reports how long it has been held', () => {
  assert.equal(lockAgeMs({ acquiredAt: 1000 }, 4000), 3000);
});

test('acquire: takes a free lock and records who holds it', async () => {
  const container = fakeContainer();
  const result = await acquire(container, 'device-a', at(5000));

  assert.equal(result.acquired, true);
  assert.equal(result.etag, container.etagOf(LOCK_PATH));
  assert.deepEqual(container.jsonOf(LOCK_PATH), { deviceId: 'device-a', acquiredAt: 5000 });
});

test('acquire: creates with a fail-if-exists precondition, not a blind overwrite', async () => {
  const container = fakeContainer();
  await acquire(container, 'device-a', at(0));
  assert.equal(container.callsOf('uploadBytes')[0].opts.ifNoneMatch, '*');
});

test('acquire: refuses when another device holds a live lock, and says who', async () => {
  const container = fakeContainer();
  container.seed(LOCK_PATH, { deviceId: 'device-b', acquiredAt: 1000 });

  const result = await acquire(container, 'device-a', at(1000 + 60_000));
  assert.equal(result.acquired, false);
  assert.equal(result.heldBy, 'device-b');
  assert.deepEqual(container.jsonOf(LOCK_PATH), { deviceId: 'device-b', acquiredAt: 1000 },
    'the other device\'s lock is left exactly as it was');
});

test('acquire: steals an abandoned lock', async () => {
  const container = fakeContainer();
  container.seed(LOCK_PATH, { deviceId: 'device-b', acquiredAt: 1000 });

  const result = await acquire(container, 'device-a', at(1000 + LOCK_STALE_MS + 1));
  assert.equal(result.acquired, true);
  assert.equal(container.jsonOf(LOCK_PATH).deviceId, 'device-a');
});

test('acquire: the steal is conditional, so only one of several racing devices wins', async () => {
  const container = fakeContainer();
  container.seed(LOCK_PATH, { deviceId: 'device-b', acquiredAt: 0 });
  await acquire(container, 'device-a', at(LOCK_STALE_MS + 1));

  const steal = container.callsOf('uploadBytes').at(-1);
  assert.ok(steal.opts.ifMatch, 'the steal names the version it expects to replace');
});

test('acquire: losing the steal race is a refusal, not an error', async () => {
  const container = fakeContainer();
  container.seed(LOCK_PATH, { deviceId: 'device-b', acquiredAt: 0 });

  // Another device wins between this one's read and its conditional write: the
  // etag it was going to match no longer exists.
  const realUpload = container.uploadBytes;
  let uploads = 0;
  container.uploadBytes = async (path, data, type, opts) => {
    uploads++;
    if (uploads === 2) {
      container.seed(LOCK_PATH, { deviceId: 'device-c', acquiredAt: LOCK_STALE_MS });
    }
    return realUpload(path, data, type, opts);
  };

  const result = await acquire(container, 'device-a', at(LOCK_STALE_MS + 1));
  assert.equal(result.acquired, false);
  assert.equal(result.heldBy, 'device-b', 'reports the holder it saw');
});

test('acquire: a lock released between the create attempt and the read is retried once', async () => {
  const container = fakeContainer();
  container.seed(LOCK_PATH, { deviceId: 'device-b', acquiredAt: 0 });

  // The holder releases in the window between the failed create and the read.
  const realRead = container.downloadJsonConditional;
  container.downloadJsonConditional = async (path, etag) => {
    await container.deleteBlob(LOCK_PATH);
    return realRead(path, etag);
  };

  const result = await acquire(container, 'device-a', at(500));
  assert.equal(result.acquired, true);
  assert.equal(container.jsonOf(LOCK_PATH).deviceId, 'device-a');
});

test('acquire: a real failure propagates instead of being read as a refusal', async () => {
  const container = fakeContainer();
  container.uploadBytes = async () => { throw new Error('HTTP 403'); };
  await assert.rejects(() => acquire(container, 'device-a'), /403/);
});

test('release: deletes only the version this device holds', async () => {
  const container = fakeContainer();
  const { etag } = await acquire(container, 'device-a', at(0));
  await release(container, etag);
  assert.equal(container.has(LOCK_PATH), false);
});

test('release: cannot delete a lock that was stolen and re-taken meanwhile', async () => {
  const container = fakeContainer();
  const { etag } = await acquire(container, 'device-a', at(0));
  // Overran the window; another device stole it.
  await acquire(container, 'device-c', at(LOCK_STALE_MS + 1));

  await assert.rejects(() => release(container, etag), (err) => err.conflict === true);
  assert.equal(container.jsonOf(LOCK_PATH).deviceId, 'device-c', 'the new owner keeps its lock');
});

test('forceRelease: deletes unconditionally, which is the point of a manual override', async () => {
  const container = fakeContainer();
  container.seed(LOCK_PATH, { deviceId: 'someone-else', acquiredAt: Date.now() });
  await forceRelease(container);
  assert.equal(container.has(LOCK_PATH), false);
});

test('status: returns the lock, null when free, and null rather than throwing on failure', async () => {
  const container = fakeContainer();
  assert.equal(await status(container), null);

  container.seed(LOCK_PATH, { deviceId: 'device-b', acquiredAt: 7 });
  assert.deepEqual(await status(container), { deviceId: 'device-b', acquiredAt: 7 });

  container.downloadJson = async () => { throw new Error('HTTP 403'); };
  assert.equal(await status(container), null, 'a status read failing must not block a sync');
});
