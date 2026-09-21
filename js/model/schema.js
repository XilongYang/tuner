// Each entity is defined exactly once, as field descriptors; every
// representation of it -- the IndexedDB record, the cloud manifest node, the
// backup-archive node -- is derived from that one definition by the generic
// mappers below. Adding a field is one line and reaches all three at once.
//
// This replaces four independently hand-written field lists (record shape,
// manifest builder, backup builder, merge function). Keeping them in step was
// manual, nothing failed loudly when they diverged, and a dropped field is
// invisible: the data is simply gone after an export or a sync.
//
// Field roles:
//   f.id()          the entity's own key.
//   f.plain(opts)   travels inline everywhere. `default` is applied with `??`
//                   (never `||`) so 0 and false survive -- offsets, durations
//                   and `hidden` all have legitimate falsy values.
//   f.content(kind) bytes too large to travel inline; see ./content.js. The
//                   record holds the value plus a `<field>Hash`; the manifest
//                   and backup node hold ONLY the hash, and the bytes live at
//                   the kind's own path.
//   f.children(def) a nested array of another entity.
//
// A content field deliberately has no `has<Field>` boolean anywhere. A hash
// is non-null exactly when content exists, so a separate flag is a second
// copy of the same fact that can disagree with it -- which is what happened
// before: three fields (hasAudio/audioHash/value) for one fact, with only
// one of the six kinds persisting its flag locally, and the UI having to test
// two of them together to get a reliable answer.

const HAS_DEFAULT = Symbol('hasDefault');

export const f = {
  id: () => ({ role: 'id' }),
  plain: (opts = {}) => ({
    role: 'plain',
    default: opts.default,
    [HAS_DEFAULT]: Object.prototype.hasOwnProperty.call(opts, 'default'),
  }),
  content: (kind) => ({ role: 'content', kind }),
  /**
   * @param {object} def
   * @param {{ merge?: 'lww'|'union' }} [opts] How two devices' copies of this
   *   array combine (see ./merge.js): 'lww' matches children by id and keeps
   *   the newer of each, 'union' keeps every child either side has. Append-only
   *   facts (a vocab occurrence is one) must be 'union' -- last-write-wins on
   *   the array would discard whichever device's additions arrived second.
   */
  children: (def, opts = {}) => ({ role: 'children', def, merge: opts.merge || 'lww' }),
};

/**
 * @param {string} name
 * @param {Record<string, object>} fields
 * @param {object} [opts]
 * @param {(record: object, parentRef: object) => object} [opts.ref]
 *   Extends the content ref as traversal descends into this entity (see
 *   ./content.js for the ref shapes). Omitted means this entity adds nothing.
 * @param {string} [opts.clock]
 *   Field holding "when this record last changed", used to pick a winner when
 *   two devices both have it. Defaults to `updatedAt`.
 * @param {string} [opts.metaClock]
 *   Field holding "when this record's own fields last changed", separate from
 *   `clock` for an entity whose children change independently of it: editing a
 *   sentence bumps its session's `updatedAt`, which must not then outrank the
 *   other device's genuine rename. Defaults to `clock`.
 */
export function entity(name, fields, opts = {}) {
  const entries = Object.entries(fields);
  const idField = entries.find(([, d]) => d.role === 'id');
  if (!idField) throw new Error(`Entity ${name} has no f.id() field`);
  const clock = opts.clock || 'updatedAt';
  return {
    name,
    fields,
    entries,
    idKey: idField[0],
    clock,
    metaClock: opts.metaClock || clock,
    ref: opts.ref || ((record, parentRef) => parentRef),
  };
}

export const hashKey = (field) => `${field}Hash`;

// ---- Entity definitions ----

export const OCCURRENCE = entity('occurrence', {
  occurrenceId: f.id(),
  sessionId: f.plain({ default: null }),
  sentenceId: f.plain({ default: null }),
  sentenceTextSnapshot: f.plain({ default: null }),
  addedAt: f.plain({ default: 0 }),
  audio: f.content('vocabAudio'),
}, {
  // audioPathKey comes from the parent entry: an occurrence's audio has to
  // stay addressable after the session and sentence it was recorded from are
  // edited or deleted, so its path is keyed by the entry, not by them.
  ref: (record, parentRef) => ({ ...parentRef, occurrenceId: record.occurrenceId }),
});

export const VOCAB_ENTRY = entity('vocabEntry', {
  id: f.id(),
  text: f.plain(),
  lang: f.plain({ default: null }),
  audioPathKey: f.plain(),
  createdAt: f.plain({ default: 0 }),
  updatedAt: f.plain({ default: 0 }),
  sources: f.children(OCCURRENCE, { merge: 'union' }),
}, {
  ref: (record) => ({ audioPathKey: record.audioPathKey }),
});

export const SENTENCE = entity('sentence', {
  id: f.id(),
  text: f.plain(),
  lang: f.plain({ default: null }),
  hidden: f.plain({ default: false }),
  updatedAt: f.plain({ default: null }),
  words: f.plain({ default: null }),
  manualPoints: f.plain({ default: null }),
  referenceSource: f.plain({ default: null }),
  sourceOffsetMs: f.plain({ default: null }),
  sourceDurationMs: f.plain({ default: null }),
  recording: f.content('recording'),
  reference: f.content('reference'),
  assessment: f.content('assessment'),
}, {
  ref: (record, parentRef) => ({ ...parentRef, sentenceId: record.id }),
});

export const SESSION = entity('session', {
  id: f.id(),
  name: f.plain({ default: null }),
  folderId: f.plain({ default: null }),
  splitMode: f.plain({ default: 'auto' }),
  createdAt: f.plain({ default: 0 }),
  updatedAt: f.plain({ default: 0 }),
  metaUpdatedAt: f.plain({ default: 0 }),
  inputText: f.content('inputText'),
  sourceAudio: f.content('sourceAudio'),
  sentences: f.children(SENTENCE, { merge: 'lww' }),
}, {
  ref: (record) => ({ sessionId: record.id }),
  metaClock: 'metaUpdatedAt',
});

export const FOLDER = entity('folder', {
  id: f.id(),
  name: f.plain({ default: null }),
  parentId: f.plain({ default: null }),
  createdAt: f.plain({ default: 0 }),
  updatedAt: f.plain({ default: 0 }),
});

// ---- Generic mappers ----

function plainValue(descriptor, record, field) {
  const raw = record[field];
  return descriptor[HAS_DEFAULT] ? (raw ?? descriptor.default) : raw;
}

/**
 * The wire/archive form: plain fields inline, content as hash only, children
 * mapped recursively. Key order follows the field declaration order, so two
 * runs over equal data produce byte-identical JSON -- which is what lets sync
 * skip an upload by comparing serialized manifests.
 */
export function toNode(def, record) {
  const out = {};
  for (const [field, d] of def.entries) {
    if (d.role === 'id' || d.role === 'plain') out[field] = plainValue(d, record, field);
    else if (d.role === 'content') out[hashKey(field)] = record[hashKey(field)] ?? null;
    else if (d.role === 'children') out[field] = (record[field] || []).map((child) => toNode(d.def, child));
  }
  return out;
}

/**
 * The inverse: a record with every plain field defaulted and every content
 * value null, ready for the caller to attach bytes it fetched (the hashes
 * say which are expected). Never invents content it does not have.
 */
export function fromNode(def, node) {
  const out = {};
  for (const [field, d] of def.entries) {
    if (d.role === 'id' || d.role === 'plain') out[field] = plainValue(d, node, field);
    else if (d.role === 'content') {
      out[field] = null;
      out[hashKey(field)] = node[hashKey(field)] ?? null;
    } else if (d.role === 'children') {
      out[field] = (node[field] || []).map((child) => fromNode(d.def, child));
    }
  }
  return out;
}

/**
 * Every content slot in `record` and its children, as a flat sequence. One
 * traversal serves sync (what to upload/download), backup (what to write into
 * the archive) and cleanup (which paths are still referenced) -- so those
 * three cannot disagree about what content an entity has.
 *
 * `hash === null` means the slot is empty; callers that only care about
 * present content filter on it (`presentContent` below).
 *
 * @returns {Generator<{kind: string, ref: object, field: string, hash: string|null, value: any, owner: object}>}
 */
export function* walkContent(def, record, parentRef = {}) {
  const ref = def.ref(record, parentRef);
  for (const [field, d] of def.entries) {
    if (d.role === 'content') {
      yield {
        kind: d.kind,
        ref,
        field,
        hash: record[hashKey(field)] ?? null,
        value: record[field] ?? null,
        owner: record,
      };
    } else if (d.role === 'children') {
      for (const child of record[field] || []) yield* walkContent(d.def, child, ref);
    }
  }
}

/**
 * A copy of `record` with the content slots `drop` selects emptied: value and
 * hash both null, children included.
 *
 * The one operation that deliberately changes what a record *claims* to have,
 * which is why it is separate from `mapContent` rather than a mode of it. It is
 * for content whose bytes turn out to be gone -- a Blob in IndexedDB is a
 * reference to a backing file, and a browser can lose it. Keeping the hash then
 * would be a claim nobody can satisfy: it names bytes this device cannot read
 * and the container does not have, and every sync from then on would offer it
 * and fail.
 *
 * @param {(slot: {kind: string, ref: object, field: string, hash: string|null}) => boolean} drop
 */
export function dropContent(def, record, drop, parentRef = {}) {
  const ref = def.ref(record, parentRef);
  const out = { ...record };
  for (const [field, d] of def.entries) {
    if (d.role === 'content') {
      const hash = record[hashKey(field)] ?? null;
      if (hash !== null && drop({ kind: d.kind, ref, field, hash })) {
        out[field] = null;
        out[hashKey(field)] = null;
      }
    } else if (d.role === 'children') {
      out[field] = (record[field] || []).map((child) => dropContent(d.def, child, drop, ref));
    }
  }
  return out;
}

/** walkContent filtered to slots that actually hold content. */
export function presentContent(def, record, parentRef = {}) {
  return [...walkContent(def, record, parentRef)].filter((c) => c.hash !== null);
}

/**
 * A copy of `record` with every content slot's value replaced by `resolve`,
 * children included. The mirror of walkContent, and the only way content is
 * attached to a record -- so a caller filling in bytes it just downloaded does
 * not have to know where in the tree they belong.
 *
 * `resolve` receives the same slot shape walkContent yields and returns the
 * value to store. Hashes are untouched: what content a record has is settled
 * before this runs, and returning a different value for a slot does not silently
 * change what it claims to be.
 *
 * @param {(slot: {kind: string, ref: object, field: string, hash: string|null, value: any}) => any} resolve
 */
export function mapContent(def, record, resolve, parentRef = {}) {
  const ref = def.ref(record, parentRef);
  const out = { ...record };
  for (const [field, d] of def.entries) {
    if (d.role === 'content') {
      out[field] = resolve({
        kind: d.kind,
        ref,
        field,
        hash: record[hashKey(field)] ?? null,
        value: record[field] ?? null,
        owner: record,
      });
    } else if (d.role === 'children') {
      out[field] = (record[field] || []).map((child) => mapContent(d.def, child, resolve, ref));
    }
  }
  return out;
}
