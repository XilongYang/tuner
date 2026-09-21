// Getting a record ready to store, and storing it.
//
// Content is addressed by hash everywhere -- it is how sync knows whether it
// already holds a recording, and it is what decides whether bytes have to be
// written at all. So a record is stamped with its content hashes on the way to
// storage, and that stamping is generic over the schema rather than written
// once per content kind.
//
// This is also the only place that puts bytes into the store, and it puts each
// one there once: a slot whose hash the content store already holds is not
// written again, however many times its record is. That is the rule the whole
// storage layout exists for (see db/content.js), and it lives here because
// here is where bytes can be read before a transaction opens.

import { SESSION, FOLDER, VOCAB_ENTRY, hashKey, walkContent } from '../model/schema.js';
import { contentKind, contentPath } from '../model/content.js';

const DEFS = { sessions: SESSION, folders: FOLDER, vocab: VOCAB_ENTRY };

/**
 * Hash one content value according to its kind: bytes are hashed as bytes, text
 * as text, and a JSON value as the exact string that will be stored -- the same
 * serialization, so a hash computed here matches one computed from what came
 * back out.
 */
function hashValue(kind, value, hash) {
  switch (contentKind(kind).encoding) {
    case 'json': return hash.hashJson(value);
    case 'text': return hash.hashString(String(value));
    default: return hash.hashBlob(value);
  }
}

/**
 * A copy of `record` with every content slot's hash matching its value.
 *
 * A slot with no value gets a null hash: a record must never claim content it
 * does not have, because sync would then look for bytes nobody holds.
 *
 * `previous` is an optimisation, not a shortcut. When a slot's value is the
 * very same object as before, its bytes cannot have changed, so the hash is
 * carried over instead of re-read. Identity is the safe direction to trust --
 * a different object with identical bytes merely costs one re-hash.
 */
export async function stampContentHashes(def, record, { hash, previous = null }) {
  const previousByPath = new Map();
  if (previous) {
    for (const slot of walkContent(def, previous)) {
      previousByPath.set(contentPath(slot.kind, slot.ref), slot);
    }
  }

  const computed = new Map();
  for (const slot of walkContent(def, record)) {
    const path = contentPath(slot.kind, slot.ref);
    if (slot.value == null) {
      computed.set(path, null);
      continue;
    }
    const before = previousByPath.get(path);
    computed.set(path, before && before.value === slot.value && before.hash
      ? before.hash
      : await hashValue(slot.kind, slot.value, hash));
  }

  return mapContentHashes(def, record, computed);
}

/** Write each slot's computed hash alongside its value. */
function mapContentHashes(def, record, computed, parentRef = {}) {
  const ref = def.ref(record, parentRef);
  const out = { ...record };
  for (const [field, d] of def.entries) {
    if (d.role === 'content') {
      out[hashKey(field)] = computed.get(contentPath(d.kind, ref)) ?? null;
    } else if (d.role === 'children') {
      out[field] = (record[field] || []).map((child) => mapContentHashes(d.def, child, computed, ref));
    }
  }
  return out;
}

/**
 * A value that owns its bytes.
 *
 * A Blob is a reference to bytes that live somewhere the page does not control
 * -- a fetch response, a file on disk, or the database itself -- and storing
 * that reference is what the content store exists to avoid. Text and JSON are
 * values already.
 */
const isBlob = (value) => typeof value?.arrayBuffer === 'function';
const selfContained = (value, hash) => (isBlob(value) ? hash.materializeBlob(value) : value);

/**
 * Stamp one record and store it, writing any content it has brought with it.
 *
 * Bytes are written when their hash is not one the content store already
 * holds, which is to say once per distinct piece of content. Every later save
 * of the same record -- a rename, a hidden toggle, a score, the twentieth
 * keystroke -- writes hashes and text, and leaves the audio where it is.
 *
 * @param {'sessions'|'folders'|'vocab'} entity
 * @returns {Promise<object>} the record as stored, hashes included and content
 *   still attached, so the caller can put it back on screen without a re-read.
 */
export async function saveRecord(entity, record, { db, hash, previous = null }) {
  const def = DEFS[entity];
  const stamped = await stampContentHashes(def, record, { hash, previous });

  const slots = [...walkContent(def, stamped)].filter((slot) => slot.hash !== null && slot.value != null);
  const held = await db.storedContentHashes(slots.map((slot) => contentPath(slot.kind, slot.ref)));

  const entries = [];
  for (const slot of slots) {
    const path = contentPath(slot.kind, slot.ref);
    if (held.get(path) === slot.hash) continue;
    entries.push({ path, kind: slot.kind, hash: slot.hash, value: await selfContained(slot.value, hash) });
  }

  await db.putRecord(entity, stamped, entries);
  return stamped;
}
