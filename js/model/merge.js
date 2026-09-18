// Conflict resolution: given this device's copy and another device's copy of
// the same data, what is the agreed result. Pure functions over plain records,
// driven by ./schema.js -- no field is named here, so a field added to the
// schema is merged without this file changing.
//
// The policy, in full:
//   * A record's own fields come from whichever side's meta clock is newer
//     (schema `metaClock`), as one group. Merging field-by-field by
//     independent clocks would let two devices' edits interleave into a
//     combination neither device ever had.
//   * Children merge by their declared strategy: 'lww' matches by id and keeps
//     the newer of each; 'union' keeps every child either side has.
//   * A deletion (tombstone) wins unless the record was edited after the
//     deletion was recorded, which is the one case where the user's later
//     intent is unambiguous.
//
// Content is deliberately absent from these decisions. Merging yields hashes
// only; whether bytes must be uploaded, downloaded or are already in hand
// follows from comparing the merged hash against the local and remote ones,
// which is the sync planner's job (../cloud/sync/plan.js). The previous design
// instead stamped each record with which side "won" and had the sync loop
// branch on that marker -- two internal fields that then had to be stripped
// before persisting, in two hand-written places.

import { hashKey } from './schema.js';

const clockOf = (record, field) => (record ? (record[field] ?? 0) : -1);

/** Tombstone key. Kind is part of it so ids only need to be unique per kind. */
export const tombstoneId = (kind, targetId) => `${kind}:${targetId}`;

/**
 * Union of two tombstone lists, keeping the earliest record of each deletion:
 * a later `deletedAt` for the same target would make an edit made before that
 * time look like it came after, resurrecting deleted data.
 */
export function mergeTombstones(local, remote) {
  const byId = new Map();
  for (const t of [...(local || []), ...(remote || [])]) {
    const existing = byId.get(t.id);
    if (!existing || t.deletedAt < existing.deletedAt) byId.set(t.id, { ...t });
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Whether a record outlives a recorded deletion of it.
 *
 * True when there is no tombstone, or when the record changed strictly after
 * the deletion (the user edited it again somewhere, which un-deletes it).
 * @param {Map<string, {deletedAt: number}>} tombstones keyed by tombstoneId()
 */
export function survives(def, record, kind, tombstones) {
  const t = tombstones?.get(tombstoneId(kind, record[def.idKey]));
  if (!t) return true;
  return clockOf(record, def.clock) > t.deletedAt;
}

/**
 * Merge one entity's two copies. Either side may be null (the other device
 * does not have it), in which case the present one is returned normalised
 * through the same path, so callers get one consistent shape.
 *
 * @param {object} def schema entity
 * @param {object|null} local
 * @param {object|null} remote
 * @param {{ tombstones?: Map<string, {deletedAt: number}>, childKind?: string }} [ctx]
 *   `childKind` is the tombstone kind to test 'lww' children against -- a
 *   sentence replaced by a split or merge is tombstoned, and without this the
 *   other device's not-yet-updated copy would come straight back alongside its
 *   replacements.
 */
export function mergeEntity(def, local, remote, ctx = {}) {
  if (!local && !remote) throw new Error(`mergeEntity(${def.name}): both sides null`);
  const base = local || remote;
  const metaWinner = clockOf(remote, def.metaClock) > clockOf(local, def.metaClock) ? (remote || base) : base;

  const out = {};
  for (const [field, d] of def.entries) {
    if (d.role === 'id') {
      out[field] = base[field];
    } else if (d.role === 'plain') {
      if (field === def.clock) {
        out[field] = Math.max(clockOf(local, field), clockOf(remote, field), 0);
      } else if (field === def.metaClock) {
        out[field] = Math.max(clockOf(local, field), clockOf(remote, field), 0);
      } else if (field === 'createdAt') {
        // Earliest wins: a record's creation time is a fact, not a preference,
        // and a device that learned about it later must not overwrite it.
        const times = [local?.createdAt, remote?.createdAt].filter((t) => typeof t === 'number');
        out[field] = times.length ? Math.min(...times) : (metaWinner[field] ?? d.default);
      } else {
        out[field] = metaWinner[field] ?? d.default;
      }
    } else if (d.role === 'content') {
      out[hashKey(field)] = metaWinner[hashKey(field)] ?? null;
      out[field] = null; // bytes are resolved separately; see this file's header
    } else if (d.role === 'children') {
      out[field] = d.merge === 'union'
        ? mergeUnion(d.def, local?.[field], remote?.[field])
        : mergeById(d.def, local?.[field], remote?.[field], ctx);
    }
  }
  return out;
}

/**
 * Children matched by id, each side's newer copy kept, order taken from
 * whichever side is newer overall so a reordering survives intact.
 */
function mergeById(def, localList, remoteList, ctx) {
  const locals = new Map((localList || []).map((c) => [c[def.idKey], c]));
  const remotes = new Map((remoteList || []).map((c) => [c[def.idKey], c]));
  // Order: the newer side's sequence, then anything only the other side has,
  // appended in its own order.
  const localNewest = Math.max(0, ...(localList || []).map((c) => clockOf(c, def.clock)));
  const remoteNewest = Math.max(0, ...(remoteList || []).map((c) => clockOf(c, def.clock)));
  const [first, second] = remoteNewest > localNewest
    ? [remoteList || [], localList || []]
    : [localList || [], remoteList || []];

  const seen = new Set();
  const out = [];
  for (const c of [...first, ...second]) {
    const id = c[def.idKey];
    if (seen.has(id)) continue;
    seen.add(id);
    const merged = mergeEntity(def, locals.get(id) || null, remotes.get(id) || null, ctx);
    if (ctx.childKind && ctx.tombstones && !survives(def, merged, ctx.childKind, ctx.tombstones)) continue;
    out.push(merged);
  }
  return out;
}

/**
 * Every child either side has, matched by id so a child both sides know about
 * appears once. Ordered by the child's own clock, then id, so two devices that
 * have converged produce identical output regardless of what order they
 * learned things in -- which is what lets the planner detect "nothing changed"
 * by comparing serialized manifests.
 */
function mergeUnion(def, localList, remoteList) {
  const byId = new Map();
  for (const c of [...(localList || []), ...(remoteList || [])]) {
    const id = c[def.idKey];
    const existing = byId.get(id);
    byId.set(id, existing ? mergeEntity(def, existing, c) : mergeEntity(def, c, null));
  }
  return [...byId.values()].sort((a, b) => {
    const byClock = clockOf(a, def.clock) - clockOf(b, def.clock);
    if (byClock) return byClock;
    return a[def.idKey] < b[def.idKey] ? -1 : a[def.idKey] > b[def.idKey] ? 1 : 0;
  });
}

/**
 * Merge two collections of top-level records of one entity, dropping those a
 * tombstone has settled. Returns survivors and casualties separately: the
 * caller has to delete the casualties locally, and a list it has to derive
 * itself is a list it can forget to derive.
 *
 * @returns {{ survivors: object[], deleted: string[] }}
 */
export function mergeCollection(def, localList, remoteList, { tombstones, kind, childKind } = {}) {
  const ids = new Set([
    ...(localList || []).map((r) => r[def.idKey]),
    ...(remoteList || []).map((r) => r[def.idKey]),
  ]);
  const locals = new Map((localList || []).map((r) => [r[def.idKey], r]));
  const remotes = new Map((remoteList || []).map((r) => [r[def.idKey], r]));

  const survivors = [];
  const deleted = [];
  for (const id of [...ids].sort()) {
    const merged = mergeEntity(def, locals.get(id) || null, remotes.get(id) || null, { tombstones, childKind });
    if (tombstones && kind && !survives(def, merged, kind, tombstones)) deleted.push(id);
    else survivors.push(merged);
  }
  return { survivors, deleted };
}
