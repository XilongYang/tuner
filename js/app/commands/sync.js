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
import { SESSION, FOLDER, VOCAB_ENTRY, walkContent, mapContent } from '../../model/schema.js';
import { contentPath } from '../../model/content.js';

const DEFS = { sessions: SESSION, folders: FOLDER, vocab: VOCAB_ENTRY };

/** The clock field each collection's staleness check compares. */
const CLOCKS = { sessions: 'updatedAt', folders: 'updatedAt', vocab: 'updatedAt' };

/** Every content value this device holds, by blob path, out of one snapshot. */
function localContentByPath(snapshot) {
  const byPath = new Map();
  for (const [key, def] of Object.entries(DEFS)) {
    for (const record of snapshot[key] || []) {
      for (const slot of walkContent(def, record)) {
        if (slot.value != null) byPath.set(contentPath(slot.kind, slot.ref), slot.value);
      }
    }
  }
  return byPath;
}

/**
 * Fill each record the plan wants written with the content it should carry:
 * what was just downloaded, or what this device already held.
 *
 * A Blob that came out of IndexedDB is re-read into memory first. The backing
 * resource of a stored Blob can be gone by the time a sync finishes its
 * transfers, and storing it then fails -- a deferred rewrap is not enough,
 * because it still does not read until the store.
 *
 * Only Blobs: content is not all binary. Practice text is a string and an
 * assessment is a plain object, and neither needs -- or survives -- being read
 * as bytes.
 */
const isBlob = (value) => typeof value?.arrayBuffer === 'function';
async function withContent(plan, { downloaded, local, materialize }) {
  const writes = [];
  for (const write of plan.localWrites) {
    const def = DEFS[write.entity];
    const slots = [];
    const record = mapContent(def, write.record, (slot) => {
      const path = contentPath(slot.kind, slot.ref);
      if (slot.hash === null) return null;
      if (downloaded.has(path)) return downloaded.get(path);
      const held = local.get(path);
      if (held == null) return null;
      if (isBlob(held)) slots.push({ path, value: held });
      return held;
    });

    // Materialise after mapping, so the traversal stays synchronous and every
    // held Blob is read exactly once.
    const readied = new Map();
    for (const { path, value } of slots) readied.set(path, await materialize(value));
    writes.push({
      ...write,
      record: readied.size
        ? mapContent(def, record, (slot) => {
          const path = contentPath(slot.kind, slot.ref);
          return readied.has(path) ? readied.get(path) : slot.value;
        })
        : record,
    });
  }
  return { ...plan, localWrites: writes };
}

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

    const local = localContentByPath(snapshot);
    const transfer = await transferContent(plan, container, {
      getValue: (slot) => local.get(slot.path) ?? null,
      onProgress,
    });

    outcome.uploaded = transfer.uploaded.length;
    outcome.downloaded = transfer.downloaded.size;
    for (const missing of transfer.missing) outcome.warnings.push(`${missing.path}: ${missing.reason}`);

    const published = await publishManifest(plan, container);
    manifestCache?.set?.({
      etag: published.published ? published.etag : (read.notModified ? cached.etag : read.etag),
      manifest: plan.manifest,
    });

    const ready = await withContent(plan, {
      downloaded: transfer.downloaded,
      local,
      materialize: hash.materializeBlob,
    });
    const applied = await db.applyPlan(ready, CLOCKS);
    outcome.written = applied.written.length;
    outcome.skipped = applied.skipped.length;
    outcome.deleted = applied.deleted.length;

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
      await release(container, lock.etag);
    } catch {
      outcome.warnings.push('the sync lock could not be released; it will expire on its own');
    }
  }
}
