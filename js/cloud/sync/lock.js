// Cross-device sync lock: a small JSON blob a device must hold before running a
// sync round against the container.
//
// This is not the same thing as keeping two tabs of the same browser from
// syncing at once (that is a Web Lock, held by whatever schedules syncs). This
// one stops two *devices* from running read-merge-write against the same
// container concurrently, which is what allows the manifest to be published
// without every writer having to win a precondition race.
//
// Mechanism: create the blob with "fail if it already exists". If it exists,
// read it -- a lock younger than LOCK_STALE_MS means another device is syncing
// now, so this round is skipped; an older one is abandoned (a device that
// closed its laptop mid-sync) and is stolen with a conditional write, so only
// one of several devices racing the same steal can win.
//
// Every function takes a container (see ../blob.js) rather than reaching for
// one, and a deviceId rather than reading it from storage, so all of this is
// testable with a plain in-memory object and no clock mocking.

export const LOCK_PATH = 'sync.lock';

/** A lock held longer than this is treated as abandoned. */
export const LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * Whether a lock record is abandoned as of `now`.
 *
 * A record with no usable timestamp counts as stale: it cannot be waited out,
 * and refusing to sync forever because of one malformed blob would be worse
 * than stealing it.
 */
export function isLockStale(lock, now = Date.now()) {
  if (!lock || typeof lock.acquiredAt !== 'number') return true;
  return now - lock.acquiredAt > LOCK_STALE_MS;
}

/** How long a lock has been held, for a status message. */
export function lockAgeMs(lock, now = Date.now()) {
  return now - (lock?.acquiredAt ?? now);
}

/**
 * @typedef {{acquired: true, etag: string|null}} Acquired
 * @typedef {{acquired: false, heldBy: string|null, lock: object|null}} Refused
 */

/**
 * Try to take the lock.
 *
 * Resolves to `{acquired: true, etag}` -- pass the etag to `release` -- or
 * `{acquired: false, heldBy, lock}` when another device holds a live one.
 * Refusal is a normal outcome and the caller should simply skip this round;
 * only an actual network or permission failure throws.
 *
 * @param {import('../blob.js').Container} container
 * @param {string} deviceId
 * @param {() => number} [clock]
 * @returns {Promise<Acquired|Refused>}
 */
export async function acquire(container, deviceId, clock = Date.now) {
  const record = () => ({ deviceId, acquiredAt: clock() });

  // Optimistic: assume it is free.
  try {
    return { acquired: true, etag: await container.uploadJson(LOCK_PATH, record(), { ifNoneMatch: '*' }) };
  } catch (err) {
    if (!err.conflict) throw err;
  }

  let existing;
  let existingEtag;
  try {
    const read = await container.downloadJsonConditional(LOCK_PATH, null);
    existing = read.value;
    existingEtag = read.etag;
  } catch (err) {
    if (!err.notFound) throw err;
    // Released between the failed create and this read. Try once more rather
    // than looping: if it is taken again in that window, another device is
    // plainly active and skipping this round is the right answer anyway.
    try {
      return { acquired: true, etag: await container.uploadJson(LOCK_PATH, record(), { ifNoneMatch: '*' }) };
    } catch (retryErr) {
      if (retryErr.conflict) return { acquired: false, heldBy: null, lock: null };
      throw retryErr;
    }
  }

  if (!isLockStale(existing, clock())) {
    return { acquired: false, heldBy: existing?.deviceId ?? null, lock: existing };
  }

  // Abandoned: steal it. The precondition means exactly one of several devices
  // attempting the same steal succeeds.
  try {
    return { acquired: true, etag: await container.uploadJson(LOCK_PATH, record(), { ifMatch: existingEtag }) };
  } catch (err) {
    if (err.conflict) return { acquired: false, heldBy: existing?.deviceId ?? null, lock: existing };
    throw err;
  }
}

/**
 * Release a lock this device took, identified by the etag `acquire` returned.
 *
 * Conditional, so a device whose lock was stolen after it overran the staleness
 * window cannot delete the new owner's lock when it finally finishes. A failure
 * here is not worth surfacing: the lock simply sits until the next round finds
 * it stale, or someone clears it by hand.
 *
 * The etag can be absent -- a CORS rule that does not expose ETag reads back as
 * none (see ../blob.js) -- and an unconditional delete there would be exactly
 * the thing this is conditional to prevent, every single time. So without one
 * it checks whose lock it is first: a narrower window than a precondition, but
 * a window rather than no check at all. A lock that turns out to belong to
 * someone else is left alone and expires on its own.
 */
export async function release(container, etag, deviceId = null) {
  if (etag) {
    await container.deleteBlob(LOCK_PATH, { ifMatch: etag });
    return;
  }

  const held = await status(container);
  // No lock to release, or not ours: either way this device has nothing to
  // delete. `null` from status is also how a read failure arrives, and
  // deleting on the strength of a read that failed is the same mistake.
  if (!held || (deviceId !== null && held.deviceId !== deviceId)) return;
  await container.deleteBlob(LOCK_PATH);
}

/**
 * Unconditional delete, for a person who has looked at the status line and
 * decided the lock is wrong -- a device that will never come back, well inside
 * the staleness window. Ignoring staleness is the entire point of a manual
 * override, so this must stay separate from `release`.
 */
export async function forceRelease(container) {
  await container.deleteBlob(LOCK_PATH);
}

/**
 * The current lock, or null if there is none.
 *
 * Never throws: a status read failing (an SAS token without read permission on
 * this one blob, say) must not be what stops a sync that would otherwise work.
 * The caller treats a failed read as "unlocked" and lets `acquire` surface any
 * real problem.
 */
export async function status(container) {
  try {
    return await container.downloadJson(LOCK_PATH);
  } catch {
    return null;
  }
}
