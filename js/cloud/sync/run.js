// Carrying out a sync plan: moving content, publishing the manifest, sweeping
// orphans. No decisions are made here -- every one of them was made by
// ./plan.js, which is pure and tested on its own.
//
// Applying the plan's local writes is deliberately NOT here: that belongs to
// whoever owns the database, and this layer must not reach into it. A sync
// command calls these functions and then hands the plan to the store.
//
// The split is what keeps the parts small. The previous implementation had all
// of this -- decisions, transfers, manifest, cleanup, local writes and status
// text -- in one ~600-line function, with six content kinds copy-pasted through
// five stages of it.

import { orphanPaths } from './plan.js';
import { contentKind, contentPath } from '../../model/content.js';
import { FOLDER, SESSION, VOCAB_ENTRY, fromNode, walkContent } from '../../model/schema.js';

export const MANIFEST_PATH = 'manifest.json';

/** Bytes for a value, in the encoding its content kind declares. */
function encode(kind, value) {
  switch (contentKind(kind).encoding) {
    case 'json': return new TextEncoder().encode(JSON.stringify(value));
    case 'text': return new TextEncoder().encode(String(value));
    default: return value; // a Blob, uploaded as-is
  }
}

/** A downloaded Blob turned back into the value its content kind implies. */
async function decode(kind, blob) {
  switch (contentKind(kind).encoding) {
    case 'json': return JSON.parse(await blob.text());
    case 'text': return blob.text();
    default: return blob;
  }
}

const noop = () => {};

/**
 * Move content both ways.
 *
 * `getValue(slot)` supplies the local value for an upload -- it is a port
 * rather than a database call so this module stays free of storage concerns,
 * and so a test can hand it a literal. Returning null means the bytes turned
 * out not to be there after all; the slot is reported as `missing` rather than
 * uploading nothing under a hash that claims content exists.
 *
 * Downloads are collected into a map keyed by blob path. The caller attaches
 * them to the records it is about to write; nothing is attached here, because
 * that would mean mutating the plan.
 *
 * A download that 404s is reported in `missing` too, and does not abort the
 * round: one unreachable clip should not stop a sync that is otherwise fine,
 * and the manifest still names it, so the next round tries again.
 *
 * @param {object} plan from planSync()
 * @param {import('../blob.js').Container} container
 * @param {object} ports
 * @param {(slot: object) => Promise<any>} ports.getValue
 * @param {(progress: {done: number, total: number, kind: string, direction: 'up'|'down'}) => void} [ports.onProgress]
 * @returns {Promise<{uploaded: string[], downloaded: Map<string, any>, reused: string[], missing: Array<{path: string, direction: string, reason: string}>}>}
 */
export async function transferContent(plan, container, { getValue, onProgress = noop }) {
  const uploads = plan.slots.filter((s) => s.action === 'upload');
  const downloads = plan.slots.filter((s) => s.action === 'download');
  const total = uploads.length + downloads.length;

  const uploaded = [];
  const downloadedValues = new Map();
  const missing = [];
  let done = 0;

  for (const slot of uploads) {
    const value = await getValue(slot);
    if (value == null) {
      missing.push({ path: slot.path, direction: 'up', reason: 'no local content for a hash that claims it exists' });
      continue;
    }
    await container.uploadBytes(slot.path, encode(slot.kind, value), contentKind(slot.kind).mime);
    uploaded.push(slot.path);
    onProgress({ done: ++done, total, kind: slot.kind, direction: 'up' });
  }

  for (const slot of downloads) {
    try {
      const blob = await container.downloadBytes(slot.path);
      downloadedValues.set(slot.path, await decode(slot.kind, blob));
    } catch (err) {
      if (!err.notFound) throw err;
      missing.push({ path: slot.path, direction: 'down', reason: 'referenced by the manifest but not in the container' });
    }
    onProgress({ done: ++done, total, kind: slot.kind, direction: 'down' });
  }

  return {
    uploaded,
    downloaded: downloadedValues,
    reused: plan.slots.filter((s) => s.action === 'reuse').map((s) => s.path),
    missing: [...missing, ...plan.unresolved.map((s) => ({ path: s.path, direction: 'none', reason: 'hash names content neither side holds' }))],
  };
}

/**
 * Publish the manifest, unless the plan already determined it would be
 * identical to what is there.
 *
 * Returns the new etag so the caller can keep it for the next round's
 * conditional read, or null when nothing was written.
 */
export async function publishManifest(plan, container) {
  if (!plan.manifestChanged) return { published: false, etag: null };
  return { published: true, etag: await container.uploadJson(MANIFEST_PATH, plan.manifest) };
}

/**
 * Read the manifest, returning null when the container has none yet.
 *
 * `knownEtag` makes it conditional: on a 304 the caller's cached manifest is
 * still current, which is the common case for a periodic sync and saves
 * re-downloading and re-parsing it every time.
 */
export async function readManifest(container, knownEtag = null) {
  try {
    const result = await container.downloadJsonConditional(MANIFEST_PATH, knownEtag);
    if (result.notModified) return { manifest: null, etag: knownEtag, notModified: true };
    return { manifest: result.value, etag: result.etag, notModified: false };
  } catch (err) {
    if (err.notFound) return { manifest: null, etag: null, notModified: false };
    throw err;
  }
}

/**
 * Delete content the plan no longer references.
 *
 * The listing is re-read here, and the reference set is the union of what this
 * plan references and what the container's *current* manifest references. That
 * second half matters: the plan was computed from a manifest read at the start
 * of the round, so content another device uploaded during it is referenced by
 * its newer manifest and by nothing this device knows about -- sweeping against
 * this plan alone would delete a file that device had just successfully synced.
 *
 * Best-effort by design: a failure returns what it managed and says why, since
 * an uncollected orphan costs storage while a failed sync costs the user their
 * round.
 */
export async function sweepOrphans(plan, container, { onProgress = noop } = {}) {
  const referenced = new Set(plan.referencedPaths);
  try {
    const current = await readManifest(container, null);
    if (current.manifest) {
      for (const path of manifestContentPaths(current.manifest)) referenced.add(path);
    }
  } catch (err) {
    return { deleted: [], skipped: true, reason: `could not re-read the manifest: ${err.message}` };
  }

  let existing;
  try {
    existing = await container.listBlobs('');
  } catch (err) {
    return { deleted: [], skipped: true, reason: `could not list the container: ${err.message}` };
  }

  const orphans = orphanPaths(referenced, existing);
  const deleted = [];
  for (const path of orphans) {
    try {
      await container.deleteBlob(path);
      deleted.push(path);
      onProgress({ done: deleted.length, total: orphans.length, path });
    } catch (err) {
      return { deleted, skipped: true, reason: `stopped after ${deleted.length}: ${err.message}` };
    }
  }
  return { deleted, skipped: false, reason: null };
}

/**
 * Every content path a manifest references.
 *
 * Reconstructs records from the manifest and walks them with the schema rather
 * than reading the manifest's shape directly, so a content kind added to the
 * schema is picked up by the sweep without this file changing.
 */
export function manifestContentPaths(manifest) {
  const paths = [];
  for (const [def, nodes] of [[FOLDER, manifest.folders], [SESSION, manifest.sessions], [VOCAB_ENTRY, manifest.vocab]]) {
    for (const node of nodes || []) {
      for (const slot of walkContent(def, fromNode(def, node))) {
        if (slot.hash !== null) paths.push(contentPath(slot.kind, slot.ref));
      }
    }
  }
  return paths;
}
