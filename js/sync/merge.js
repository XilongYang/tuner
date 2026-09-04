// Merge helpers (last-write-wins, at sentence granularity) shared by
// syncWithAzure(): decide, field by field, whose value survives when the
// same session exists on two devices with independent edits since the last
// sync. See the module-level comment on syncWithAzure() in ./azure-sync.js
// for why this tracks three separate "changed at" signals instead of one.

export function pickNewer(aTs, bTs) {
  return (bTs || 0) > (aTs || 0) ? 'b' : 'a';
}

/**
 * Per-sentence-id union + LWW merge. Tags each surviving sentence with which
 * side it came from (`__from`, stripped before storage/manifest use) so the
 * sync flow below knows, without re-deriving it, whether it already holds
 * that sentence's winning recording or still needs to fetch/send it.
 *
 * No tombstones: sentences are never added to or removed from a session after
 * Split (js/app.js's handleSplit is the only place the array is rebuilt), so
 * there is no "sentence N was deleted" state this needs to represent. Order
 * follows `local`'s sequence -- both sides descend from the same Split, so
 * they should already agree on it; any id that exists only remotely (e.g.
 * this device has never seen this session before) is appended at the end.
 */
export function mergeSentences(local, remote) {
  const remoteById = new Map((remote || []).map((s) => [s.id, s]));
  const seen = new Set();
  const merged = (local || []).map((l) => {
    seen.add(l.id);
    const r = remoteById.get(l.id);
    if (!r) return { ...l, __from: 'local' };
    return pickNewer(l.updatedAt, r.updatedAt) === 'b' ? { ...r, __from: 'remote' } : { ...l, __from: 'local' };
  });
  for (const r of remote || []) {
    if (!seen.has(r.id)) merged.push({ ...r, __from: 'remote' });
  }
  return merged;
}

/**
 * Merge one session. Metadata resolves via `metaUpdatedAt` specifically (not
 * sentence `updatedAt`s, not the general `updatedAt`) so a rename on device A
 * and an unrelated recording on device B, made around the same time, both
 * survive instead of one clobbering the other. `local`/`remote` may each be
 * absent (session known to only one side); `mergeSentences` above handles
 * that directly rather than short-circuiting here, so every sentence still
 * gets tagged with its origin.
 */
export function mergeSession(local, remote) {
  const base = local || remote;
  const localMeta = local ? (local.metaUpdatedAt ?? local.updatedAt ?? local.createdAt ?? 0) : -1;
  const remoteMeta = remote ? (remote.metaUpdatedAt ?? remote.updatedAt ?? remote.createdAt ?? 0) : -1;
  const metaFrom = remoteMeta > localMeta ? 'remote' : 'local';
  const metaWinner = metaFrom === 'remote' ? remote : base;
  return {
    id: base.id,
    createdAt: Math.min(local?.createdAt ?? Infinity, remote?.createdAt ?? Infinity),
    updatedAt: Math.max(local?.updatedAt || 0, remote?.updatedAt || 0),
    metaUpdatedAt: Math.max(localMeta < 0 ? 0 : localMeta, remoteMeta < 0 ? 0 : remoteMeta),
    name: metaWinner.name,
    folderId: metaWinner.folderId,
    splitMode: metaWinner.splitMode,
    // inputText itself: only the LOCAL copy ever carries the actual text --
    // a remote manifest entry only has inputTextHash (see the manifest
    // shape in syncWithAzure()). __metaFrom tells the sync loop whether it
    // still needs to fetch/keep the actual text, same idea as `__from` on a
    // sentence for its recording/assessment.
    inputText: metaWinner.inputText ?? null,
    inputTextHash: metaWinner.inputTextHash || null,
    __metaFrom: metaFrom,
    sentences: mergeSentences(local?.sentences, remote?.sentences),
  };
}

/** Folder counterpart: no sub-structure, so a plain LWW on `updatedAt` is enough. */
export function mergeFolder(local, remote) {
  if (!local) return { ...remote };
  if (!remote) return { ...local };
  return (remote.updatedAt || 0) > (local.updatedAt || 0) ? { ...remote } : { ...local };
}

/** Union two lists by `id`, merging entries present on both sides via `mergeOne`. */
export function mergeById(localList, remoteList, mergeOne) {
  const remoteById = new Map((remoteList || []).map((r) => [r.id, r]));
  const seen = new Set();
  const merged = (localList || []).map((l) => {
    seen.add(l.id);
    return mergeOne(l, remoteById.get(l.id));
  });
  for (const r of remoteList || []) {
    if (!seen.has(r.id)) merged.push(mergeOne(null, r));
  }
  return merged;
}

/**
 * Union two tombstone lists by id ("<kind>:<targetId>", from js/store.js),
 * keeping whichever `deletedAt` is newer -- deletions merge the same way
 * edits do, just with a one-bit payload ("gone").
 */
export function mergeTombstones(localList, remoteList) {
  const byId = new Map();
  for (const t of localList || []) byId.set(t.id, t);
  for (const t of remoteList || []) {
    const existing = byId.get(t.id);
    if (!existing || t.deletedAt > existing.deletedAt) byId.set(t.id, t);
  }
  return Array.from(byId.values());
}

/**
 * Whether a merged folder/session should still exist after accounting for
 * tombstones: a delete beats an item's own `updatedAt` unless something
 * touched that item again AFTER the delete (an edit newer than the
 * tombstone "un-deletes" it, same principle as any other LWW field here).
 * This is what makes a deletion actually stick across devices instead of
 * being resurrected by the next pull from whichever side still has it.
 */
export function survivesTombstone(kind, item, tombstoneById) {
  const t = tombstoneById.get(`${kind}:${item.id}`);
  if (!t) return true;
  return (item.updatedAt || 0) > t.deletedAt;
}