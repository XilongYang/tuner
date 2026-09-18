// Sync planning: given what this device has and what the container has, decide
// everything that should happen -- and do no IO at all.
//
// The entire decision surface of bidirectional sync lives in this one pure
// function. That is the point: every interesting case (a field edited on both
// sides, a delete racing an edit, two devices' vocab occurrences diverging,
// content present remotely but not locally, nothing changed at all) is
// reachable in a test with object literals, in microseconds, with no fake
// container, no IndexedDB and no module mocking.
//
// ./run.js performs the plan and makes no decisions. The split is what keeps
// either half comprehensible: the previous implementation interleaved both in
// one ~600-line function, six content kinds copy-pasted through five stages of
// it, and the guard that stops a sync from resurrecting data the user deleted
// mid-flight had to be written once per entity kind -- so the kind added last
// shipped without it.
//
// Content decisions are made from hashes alone. A slot's merged hash is either
// one this device already holds (reuse, and upload if the container lacks it)
// or one it does not (download). Nothing needs to record which side "won".

import {
  SESSION, FOLDER, VOCAB_ENTRY, toNode, fromNode, walkContent,
} from '../../model/schema.js';
import { contentPath, CONTENT_KINDS } from '../../model/content.js';
import { mergeCollection, mergeTombstones, tombstoneId } from '../../model/merge.js';

export const MANIFEST_VERSION = 6;

/**
 * @typedef {object} Snapshot
 * @property {object[]} folders
 * @property {object[]} sessions
 * @property {object[]} vocab
 * @property {object[]} tombstones
 */

/**
 * @typedef {object} Slot
 * @property {string} kind      Content kind (see model/content.js).
 * @property {string} path      Blob path; also the slot's identity.
 * @property {object} ref
 * @property {string} hash
 * @property {'upload'|'download'|'reuse'|'unresolved'} action
 * @property {'bytes'|'text'|'json'} encoding
 * @property {string} entity    Which collection the owner is in.
 * @property {string} ownerId   Top-level record id, so the runner can find the owner.
 */

const collections = [
  { key: 'folders', def: FOLDER, kind: 'folder', childKind: null },
  { key: 'sessions', def: SESSION, kind: 'session', childKind: 'sentence' },
  { key: 'vocab', def: VOCAB_ENTRY, kind: 'vocab', childKind: null },
];

/** Every content slot of a collection, indexed by blob path. */
function slotsByPath(def, records) {
  const map = new Map();
  for (const record of records || []) {
    for (const slot of walkContent(def, record)) {
      map.set(contentPath(slot.kind, slot.ref), { ...slot, ownerId: record[def.idKey] });
    }
  }
  return map;
}

/**
 * Plan one sync round.
 *
 * @param {object} args
 * @param {Snapshot} args.local           This device's data, content hashes included, bytes not needed.
 * @param {object|null} args.remote       The container's manifest, or null when there is none yet.
 * @returns {{
 *   slots: Slot[],
 *   localWrites: Array<{entity: string, record: object, baseClock: number|null}>,
 *   localDeletes: Array<{entity: string, id: string}>,
 *   tombstones: object[],
 *   manifest: object,
 *   manifestChanged: boolean,
 *   referencedPaths: Set<string>,
 *   unresolved: Slot[]
 * }}
 */
export function planSync({ local, remote }) {
  const remoteManifest = remote || emptyManifest();
  const tombstones = mergeTombstones(local.tombstones, remoteManifest.tombstones);
  const tombstoneMap = new Map(tombstones.map((t) => [t.id, t]));

  const merged = {};
  const localWrites = [];
  const localDeletes = [];
  const slots = [];
  const referencedPaths = new Set();

  for (const { key, def, kind, childKind } of collections) {
    const localRecords = local[key] || [];
    const remoteRecords = (remoteManifest[key] || []).map((node) => fromNode(def, node));

    const { survivors, deleted } = mergeCollection(def, localRecords, remoteRecords, {
      tombstones: tombstoneMap, kind, childKind,
    });
    merged[key] = survivors;

    for (const id of deleted) localDeletes.push({ entity: key, id });

    const localSlots = slotsByPath(def, localRecords);
    const remoteSlots = slotsByPath(def, remoteRecords);
    const localClocks = new Map(localRecords.map((r) => [r[def.idKey], r[def.clock] ?? 0]));

    for (const record of survivors) {
      localWrites.push({
        entity: key,
        record,
        // What the record's local clock read when this plan was computed. The
        // runner refuses the write if it has moved since -- one check, in one
        // place, for every entity kind. null means the record is new to this
        // device, so there is nothing to race against.
        baseClock: localClocks.has(record[def.idKey]) ? localClocks.get(record[def.idKey]) : null,
        id: record[def.idKey],
      });

      for (const slot of walkContent(def, record)) {
        const path = contentPath(slot.kind, slot.ref);
        if (slot.hash === null) continue;
        referencedPaths.add(path);
        const localHash = localSlots.get(path)?.hash ?? null;
        const remoteHash = remoteSlots.get(path)?.hash ?? null;
        slots.push({
          kind: slot.kind,
          path,
          ref: slot.ref,
          hash: slot.hash,
          encoding: CONTENT_KINDS[slot.kind].encoding,
          entity: key,
          ownerId: record[def.idKey],
          field: slot.field,
          action: contentAction(slot.hash, localHash, remoteHash),
        });
      }
    }
  }

  // Deletions this device learned about apply to folders/sessions/vocab that
  // survived the merge but point at a folder that did not, which would leave
  // the tree unable to place them. Reparent to the root instead of dropping.
  const survivingFolderIds = new Set(merged.folders.map((f) => f.id));
  for (const folder of merged.folders) {
    if (folder.parentId != null && !survivingFolderIds.has(folder.parentId)) folder.parentId = null;
  }
  for (const session of merged.sessions) {
    if (session.folderId != null && !survivingFolderIds.has(session.folderId)) session.folderId = null;
  }

  const manifest = buildManifest(merged, tombstones);
  return {
    slots,
    localWrites,
    localDeletes,
    tombstones,
    manifest,
    // No timestamp lives in the manifest, so equal data serializes to equal
    // bytes and this comparison is meaningful. (A "written at" field would
    // differ on every run and defeat it; the blob's own Last-Modified already
    // records that.)
    manifestChanged: JSON.stringify(manifest) !== JSON.stringify(remoteManifest),
    referencedPaths,
    unresolved: slots.filter((s) => s.action === 'unresolved'),
  };
}

/**
 * The merged hash is the only input needed:
 *   held locally and missing remotely -> upload it
 *   held locally and present remotely -> nothing to do
 *   not held locally                  -> download it from the container
 *   held by neither                   -> unresolved: the hash references bytes
 *                                        nobody has. Surfaced rather than
 *                                        attempted, so it reads as a real
 *                                        fault instead of a 404 in a loop.
 */
function contentAction(hash, localHash, remoteHash) {
  if (hash === localHash) return hash === remoteHash ? 'reuse' : 'upload';
  if (hash === remoteHash) return 'download';
  return 'unresolved';
}

export function emptyManifest() {
  return buildManifest({ folders: [], sessions: [], vocab: [] }, []);
}

/** Key order is fixed here and inside toNode, which is what makes manifests comparable. */
function buildManifest(merged, tombstones) {
  return {
    version: MANIFEST_VERSION,
    folders: (merged.folders || []).map((r) => toNode(FOLDER, r)),
    sessions: (merged.sessions || []).map((r) => toNode(SESSION, r)),
    vocab: (merged.vocab || []).map((r) => toNode(VOCAB_ENTRY, r)),
    tombstones: tombstones.map((t) => ({ id: t.id, kind: t.kind ?? tombstoneKind(t.id), targetId: t.targetId ?? tombstoneTarget(t.id), deletedAt: t.deletedAt })),
  };
}

const tombstoneKind = (id) => String(id).slice(0, String(id).indexOf(':'));
const tombstoneTarget = (id) => String(id).slice(String(id).indexOf(':') + 1);

/** Slots with a given action, in plan order. */
export const slotsFor = (plan, action) => plan.slots.filter((s) => s.action === action);

/**
 * Paths under each content kind's prefix that the plan does not reference, out
 * of a listing of what the container actually holds. Pure, so the sweep's
 * arithmetic is testable without a container; ./run.js supplies the listing and
 * performs the deletes.
 */
export function orphanPaths(referencedPaths, existingPaths) {
  const prefixes = Object.values(CONTENT_KINDS).map((k) => k.prefix);
  return existingPaths.filter((p) => prefixes.some((prefix) => p.startsWith(prefix)) && !referencedPaths.has(p));
}

export { tombstoneId };
