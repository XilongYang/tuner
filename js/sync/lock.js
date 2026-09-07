// Cross-device sync lock: a small JSON blob (tuner/sync.lock) that a device
// must hold before it's allowed to run syncWithAzure()'s read-merge-write
// cycle. This is a DIFFERENT thing from the Web Locks mutex in ./scheduler.js
// -- that one only keeps two tabs in the SAME browser from both calling
// syncWithAzure() at once; this one keeps two different DEVICES/browsers
// from doing so concurrently against the same Azure container, which is what
// actually caused the unconditioned manifest-overwrite race (see the big
// comment on the manifest upload in ./azure-sync.js).
//
// Mechanism: acquire() creates the lock blob with `If-None-Match: *` (fails
// if it already exists -- Azure's create-only precondition). If it already
// exists, we GET it: if it's younger than LOCK_STALE_MS, someone else is
// actively syncing and we give up for this round (the caller just skips the
// sync, same as any other "someone else is syncing" outcome). If it's
// STALE -- older than the timeout, almost certainly because that device died
// or lost its network mid-sync and never got to release() -- we try to
// "steal" it: PUT a new lock body with `If-Match: <the stale lock's ETag>`.
// That conditional write is what keeps two devices racing to steal the same
// stale lock from both succeeding: only one of their If-Match preconditions
// can still be true once the other's write lands first.
//
// release() is a conditional DELETE (`If-Match: <our own lock's ETag>`) --
// not an unconditional one -- so a device that overran the timeout and had
// its lock stolen out from under it can't then delete the NEW owner's lock
// when it finally gets back around to its own `finally` block.
//
// forceReleaseLock() is the escape hatch for the manual "Clear sync lock"
// button: an unconditional DELETE, for a human who's looked at the status
// line and decided the lock is wrong (e.g. a device that will never come
// back, well within the 10-minute window). It does not check staleness --
// that's the point of a MANUAL override.
//
// isLockStale() is factored out as a pure function (data + a clock in, a
// boolean out) so it can be unit-tested without any network or fake-timer
// setup, matching this codebase's existing pattern (see
// findSessionsChangedSinceSnapshot() in ./azure-sync.js).

import * as blobStore from '../azure-blob.js';
import { getDeviceId } from '../config.js';

export const BLOB_LOCK_PATH = 'tuner/sync.lock';
export const LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes

/** Whether a lock record is stale (abandoned) as of `now` (a ms timestamp; defaults to Date.now()). */
export function isLockStale(lockData, now = Date.now()) {
  if (!lockData || typeof lockData.acquiredAt !== 'number') return true;
  return now - lockData.acquiredAt > LOCK_STALE_MS;
}

/** How long ago (ms) a lock record was acquired, for a human-readable "Ym ago" status message. */
export function lockAgeMs(lockData, now = Date.now()) {
  return now - lockData.acquiredAt;
}

/**
 * Current lock status, or null if unlocked. Never throws -- a lock-status
 * check failing (e.g. the SAS token's List/Read permission missing on this
 * one extra blob) shouldn't be what blocks a sync that would otherwise be
 * fine; the caller treats a failed status check the same as "unlocked" and
 * lets the subsequent acquire() attempt surface any real permission problem.
 */
export async function getLockStatus(sasUrl) {
  try {
    const lock = await blobStore.downloadJson(sasUrl, BLOB_LOCK_PATH);
    return lock;
  } catch (err) {
    if (err.notFound) return null;
    return null;
  }
}

/**
 * Try to acquire the sync lock. Returns `{ acquired: true, etag }` on
 * success (pass `etag` back to release()). Returns `{ acquired: false,
 * lock }` if another device currently holds a non-stale lock (`lock` is its
 * record, for the "locked by X, Ym ago" status message). Throws only on an
 * actual network/permission failure.
 */
export async function acquireLock(sasUrl) {
  const body = { deviceId: getDeviceId(), acquiredAt: Date.now() };
  const bytes = new TextEncoder().encode(JSON.stringify(body));

  // First attempt: assume no one holds the lock.
  try {
    const etag = await blobStore.uploadBytes(sasUrl, BLOB_LOCK_PATH, bytes, 'application/json', { ifNoneMatch: '*' });
    return { acquired: true, etag };
  } catch (err) {
    if (!err.conflict) throw err;
  }

  // Someone already holds (or left) a lock blob -- look at it.
  let existing;
  let existingEtag;
  try {
    const dl = await blobStore.downloadJsonConditional(sasUrl, BLOB_LOCK_PATH, null);
    existing = dl.value;
    existingEtag = dl.etag;
  } catch (err) {
    if (err.notFound) {
      // Released between our failed create and this GET -- try once more,
      // straightforwardly, rather than looping indefinitely.
      try {
        const etag = await blobStore.uploadBytes(sasUrl, BLOB_LOCK_PATH, bytes, 'application/json', { ifNoneMatch: '*' });
        return { acquired: true, etag };
      } catch (err2) {
        if (err2.conflict) return { acquired: false, lock: null };
        throw err2;
      }
    }
    throw err;
  }

  if (!isLockStale(existing)) {
    return { acquired: false, lock: existing };
  }

  // Stale -- try to steal it. The If-Match precondition means only one of
  // possibly several devices racing this same steal can win.
  try {
    const etag = await blobStore.uploadBytes(sasUrl, BLOB_LOCK_PATH, bytes, 'application/json', { ifMatch: existingEtag });
    return { acquired: true, etag };
  } catch (err) {
    if (err.conflict) return { acquired: false, lock: existing };
    throw err;
  }
}

/**
 * Release a lock this device acquired, identified by the ETag acquire()
 * returned. Conditional (If-Match) so a lock this device lost to a steal
 * (because it overran LOCK_STALE_MS) is never deleted out from under its new
 * owner. Best-effort: a failure here is left for the caller to swallow (a
 * lock that outlives its sync just sits there until the next sync's staleness
 * check or a manual clear -- not a correctness problem, just a delay).
 */
export async function releaseLock(sasUrl, etag) {
  await blobStore.deleteBlob(sasUrl, BLOB_LOCK_PATH, { ifMatch: etag });
}

/**
 * Unconditional delete, for the manual "Clear sync lock" button -- a human
 * override that doesn't check staleness or ownership. Treats "already gone"
 * as success (deleteBlob() already does).
 */
export function forceReleaseLock(sasUrl) {
  return blobStore.deleteBlob(sasUrl, BLOB_LOCK_PATH);
}
