// One sync round, start to finish.
//
// This is the only place that knows both the container and the database, which
// is why it lives here rather than in cloud/. Everything it does is delegated:
// the decisions to cloud/sync/plan.js, the transfers to cloud/sync/run.js, the
// exclusion to cloud/sync/lock.js, and the local write to db/entities.js. What
// remains here is the order, and reporting what happened.
//
// The order matters and is fixed: take the lock, read, plan, upload, publish,
// write locally, sweep, release. Publishing before writing locally means a
// failure in between leaves the container ahead of this device, which the next
// round simply pulls; the reverse would leave content referenced by nothing.

import { planSync } from '../../cloud/sync/plan.js';
import { transferContent, publishManifest, readManifest, sweepOrphans } from '../../cloud/sync/run.js';
import { acquire, release } from '../../cloud/sync/lock.js';
import { eraseContainer } from '../../cloud/sync/erase.js';
import { SESSION, VOCAB_ENTRY, dropContent } from '../../model/schema.js';
import { contentPath } from '../../model/content.js';

const DEFS = { sessions: SESSION, vocab: VOCAB_ENTRY };

/** The clock field each collection's staleness check compares. */
const CLOCKS = { sessions: 'updatedAt', vocab: 'updatedAt' };

/**
 * The same snapshot with the content at `paths` given up: no value, no hash.
 *
 * Pure, and it goes through the schema rather than naming fields, so a content
 * kind added later is covered without touching this.
 */
function withoutContent(snapshot, paths) {
  const out = { ...snapshot };
  for (const [key, def] of Object.entries(DEFS)) {
    out[key] = (snapshot[key] || []).map((record) => (
      dropContent(def, record, (slot) => paths.has(contentPath(slot.kind, slot.ref)))
    ));
  }
  return out;
}

const isBlob = (value) => typeof value?.arrayBuffer === 'function';

/**
 * The content a round downloaded, as entries for the content store.
 *
 * Nothing is attached to a record: a stored record carries hashes, and the
 * bytes go beside it under the hash. A downloaded value came off the network
 * and owns its bytes, so it is stored as it is.
 *
 * Each entry names the record it belongs to, because the store writes bytes
 * only for records that were actually written -- see db/entities.js.
 */
const contentEntries = (plan, downloaded) => plan.slots
  .filter((slot) => downloaded.has(slot.path))
  .map((slot) => ({
    kind: slot.kind, hash: slot.hash,
    ownerId: slot.ownerId, value: downloaded.get(slot.path),
  }));

/**
 * Run one round.
 *
 * Returns what happened rather than throwing for the ordinary outcomes -- no
 * container configured, another device holding the lock -- because those are
 * things to tell the user, not faults. A genuine failure (no permission, no
 * network) is reported the same way, with its message, so a caller has one
 * shape to render.
 *
 * @returns {Promise<{ok: boolean, reason: string|null, uploaded: number, downloaded: number,
 *   written: number, skipped: number, deleted: number, swept: number, warnings: string[]}>}
 */
export async function syncNow({ deps }) {
  const { container, db, settings, hash, manifestCache, onProgress } = deps;

  const outcome = {
    ok: false, reason: null, uploaded: 0, downloaded: 0,
    written: 0, skipped: 0, deleted: 0, swept: 0, warnings: [],
  };

  if (!container) return { ...outcome, reason: 'not-configured' };

  let lock;
  try {
    lock = await acquire(container, settings.deviceId());
  } catch (err) {
    return { ...outcome, reason: `lock-failed: ${err.message}` };
  }
  if (!lock.acquired) {
    return { ...outcome, reason: lock.heldBy ? `locked-by:${lock.heldBy}` : 'locked' };
  }

  try {
    const cached = manifestCache?.get?.() ?? { etag: null, manifest: null };
    const read = await readManifest(container, cached.etag);
    const remote = read.notModified ? cached.manifest : read.manifest;

    const snapshot = await db.snapshot();
    const plan = planSync({ local: snapshot, remote });

    // Bytes this device claims to hold and turned out not to be able to read.
    const unreadable = new Map();
    const transfer = await transferContent(plan, container, {
      // One slot's bytes, read when that slot is uploaded and not before: a
      // round that has to send a whole library should not hold the whole
      // library in memory to do it. Reading here also means a clip whose bytes
      // are gone is found as that, rather than as an opaque network error about
      // the SAS URL, which is the wrong thing to go looking at.
      //
      // By hash, so what is read is the bytes the plan named or nothing: a
      // sentence recorded again while the round is in flight cannot have its
      // new take sent under the old claim.
      getValue: async (slot) => {
        const entry = await db.readContent(slot.hash);
        if (!entry || entry.value == null) return null;
        if (!isBlob(entry.value)) return entry.value;
        try {
          // Read now rather than handing fetch() a Blob to read later: a Blob
          // whose bytes are gone fails inside fetch as a connection problem,
          // and that sends the search in the wrong direction entirely.
          return await hash.materializeBlob(entry.value);
        } catch (err) {
          unreadable.set(slot.path, err.message);
          return null;
        }
      },
      onProgress,
    });

    outcome.uploaded = transfer.uploaded.length;
    outcome.downloaded = transfer.downloaded.size;

    // Content that was due to go up and did not. The manifest must not claim
    // it: a claim is "these bytes exist and can be fetched", and publishing one
    // for a blob that never arrived is the one failure this design cannot
    // recover from on its own -- this device would read its own claim back as
    // `reuse` and stop offering the bytes, while every other device downloads a
    // 404 for good.
    //
    // So the round publishes a manifest without those slots, and changes
    // nothing locally: the record keeps its hash, the sentence keeps whatever
    // is left of its clip, and because the container does not claim the bytes,
    // every later round offers them again. Nothing is discarded on the strength
    // of one failed read, and the warning says so on every round until either
    // the bytes go up or the user replaces them.
    const withheld = new Set([
      ...unreadable.keys(),
      ...transfer.missing.filter((m) => m.direction === 'up').map((m) => m.path),
    ]);

    const publishedPlan = withheld.size
      ? planSync({ local: withoutContent(snapshot, withheld), remote })
      : plan;
    const published = await publishManifest(publishedPlan, container);
    manifestCache?.set?.({
      etag: published.published ? published.etag : (read.notModified ? cached.etag : read.etag),
      // What is actually up there, which is not what this device holds when
      // something was withheld.
      manifest: publishedPlan.manifest,
    });

    // Records and the bytes they arrived with, in one transaction. Nothing this
    // device already holds is rewritten: an unchanged clip is not touched by a
    // round at all, which is the point of the content store. Content the
    // round leaves unreferenced here is collected in that transaction too.
    const applied = await db.applyPlan(plan, CLOCKS, { content: contentEntries(plan, transfer.downloaded) });
    outcome.written = applied.written.length;
    outcome.skipped = applied.skipped.length;
    outcome.deleted = applied.deleted.length;

    // What was withheld, said once each, and said rightly: a slot whose record
    // moved on under the plan (its write was skipped) is a take replaced while
    // the round ran -- the old bytes were collected with it -- not bytes lost.
    const movedOn = new Set(applied.skipped);
    for (const missing of transfer.missing) {
      if (unreadable.has(missing.path)) continue;
      const slot = plan.slots.find((s) => s.path === missing.path);
      outcome.warnings.push(missing.direction === 'up' && slot && movedOn.has(slot.ownerId)
        ? `${missing.path}: replaced while the round was running; the new bytes go up next round`
        : `${missing.path}: ${missing.reason}`);
    }
    for (const [path, message] of unreadable) {
      outcome.warnings.push(`${path}: the local copy could not be read (${message}); it stays out of the cloud copy, and the record keeps it, until it can be read again`);
    }

    const sweep = await sweepOrphans(plan, container, { onProgress });
    outcome.swept = sweep.deleted.length;
    if (sweep.skipped) outcome.warnings.push(`orphan cleanup skipped: ${sweep.reason}`);

    outcome.ok = true;
    return outcome;
  } catch (err) {
    return { ...outcome, reason: err.message };
  } finally {
    // Best effort: a lock that outlives its round is claimed by the next
    // device's staleness check, which is a delay rather than a fault, and must
    // never replace the outcome being reported.
    try {
      await release(container, lock.etag, settings.deviceId());
    } catch {
      outcome.warnings.push('the sync lock could not be released; it will expire on its own');
    }
  }
}

/**
 * Empty the container, leaving this device's own data alone.
 *
 * For a container whose contents have stopped making sense -- a half-written
 * round, blobs the manifest has lost track of, a version this build no longer
 * reads. It is the cloud copy that is discarded, not the practice: the next
 * sync finds nothing there and uploads what this device holds.
 *
 * Takes the lock first, like any round, so nothing is mid-write while it runs,
 * and drops the cached manifest afterwards -- the cache describes a container
 * that no longer exists, and a sync trusting it would publish a manifest
 * pointing at blobs that were just deleted.
 */
export async function eraseCloud({ deps }) {
  const { container, settings, manifestCache, onProgress } = deps;

  if (!container) return { ok: false, reason: 'not-configured', deleted: 0 };

  let lock;
  try {
    lock = await acquire(container, settings.deviceId());
  } catch (err) {
    return { ok: false, reason: `lock-failed: ${err.message}`, deleted: 0 };
  }
  if (!lock.acquired) {
    return { ok: false, reason: lock.heldBy ? `locked-by:${lock.heldBy}` : 'locked', deleted: 0 };
  }

  try {
    const result = await eraseContainer(container, { onProgress });
    // Dropped whether or not every blob went: what is left up there is not what
    // the cache says either way.
    manifestCache?.set?.({ etag: null, manifest: null });

    return result.reason
      ? { ok: false, reason: result.reason, deleted: result.deleted.length }
      : { ok: true, reason: null, deleted: result.deleted.length };
  } finally {
    try {
      await release(container, lock.etag, settings.deviceId());
    } catch {
      // The lock expires on its own; the erase itself is already reported.
    }
  }
}
