// Single source of truth for which plain (non-Blob) fields make up a
// folder/session/sentence/vocab-entry/vocab-source record wherever this app
// has to build or reconstruct one from a serialized form -- the .tuner
// backup ZIP (store/backup.js, both directions), a full Azure restore
// (sync/restore.js, the download-reconstruction direction), AND
// sync/azure-sync.js's own incremental manifest upload. All three used to
// hand-copy the exact same field list independently, with the exact same
// per-field `?? null` fallback -- a field added to one copy and not the
// other silently drops data on export/restore/sync, with no error anywhere;
// this already happened once (the vocab field was fixed in store/backup.js,
// then found missing from history-panel/actions.js's own call site, in two
// separate passes) before this file existed.
//
// azure-sync.js was deliberately left OUT of this file at first -- its field
// list is entangled with content-hash-diffing merge logic, represents a few
// fields differently on purpose (a boolean `hasRecording` flag plus a
// separately-fetched blob, instead of an inline value or a ZIP file
// reference), and had no test coverage at all in this repo, so folding it in
// without a safety net risked the live sync path silently. Once
// tests/azure-sync.test.mjs/tests/restore.test.mjs existed to catch a
// field-shape regression, it was brought in too -- azure-sync.js layers its
// own has-flags on top of pickFields()'s output (see its own manifest-build
// comment) rather than trying to make this file describe those too, since
// they're a real format difference, not duplicated knowledge.
//
// One accepted, one-time side effect from adding azure-sync.js: pickFields()
// inserts keys in a different order than the manifest object literals used
// to write them by hand, so the very next sync after this changed re-uploads
// the manifest once even when nothing actually changed (the "skip if
// byte-identical to what's already on Azure" check in syncWithAzure()
// compares JSON.stringify output, which is key-order-sensitive) -- a single
// harmless extra upload, not a data problem, and it self-corrects from the
// next sync onward once both sides use the new order.

export const FOLDER_FIELDS = ['id', 'name', 'createdAt', 'updatedAt'];
export const FOLDER_OPTIONAL_FIELDS = { parentId: null };

// Session fields other than inputText (handled specially -- backup.js embeds
// the raw text, restore.js downloads it from its own blob) and the blob
// fields themselves (sourceAudioBlob), which each caller attaches after
// calling pickFields() since where the bytes come from differs per format.
export const SESSION_FIELDS = ['id', 'name', 'splitMode', 'createdAt', 'updatedAt'];
export const SESSION_OPTIONAL_FIELDS = {
  folderId: null,
  inputTextHash: null,
  sourceAudioHash: null,
};

// Sentence fields other than the blob fields themselves (recordingBlob/
// referenceBlob), attached after pickFields() the same way.
export const SENTENCE_FIELDS = ['id', 'text', 'lang', 'hidden'];
export const SENTENCE_OPTIONAL_FIELDS = {
  updatedAt: null,
  recordingHash: null,
  referenceHash: null,
  assessmentHash: null,
  referenceSource: null,
  sourceOffsetMs: null,
  sourceDurationMs: null,
  words: null,
  manualPoints: null,
};

export const VOCAB_ENTRY_FIELDS = ['id', 'text', 'lang', 'audioPathKey', 'createdAt', 'updatedAt'];

// Vocab source fields other than the blob field itself (audioBlob).
export const VOCAB_SOURCE_FIELDS = ['occurrenceId', 'sessionId', 'sentenceId', 'sentenceTextSnapshot', 'addedAt'];
export const VOCAB_SOURCE_OPTIONAL_FIELDS = { audioHash: null };

/**
 * Build a fresh plain object with exactly `required` (copied through as-is
 * -- absent here means a caller bug, not a legitimate "missing" state) plus
 * `optional`'s keys (a {field: fallback} map, applied via `??` -- never
 * `||`, since sourceOffsetMs/sourceDurationMs can legitimately be 0, which
 * `||` would wrongly treat as missing). Deliberately not a blind
 * `{...source}` spread, which would also carry along a source's Blob fields
 * or an app-internal field (e.g. row.js's live in-memory `recorder` handle)
 * into a serialized record that never wants them.
 */
export function pickFields(source, required, optional = {}) {
  const out = {};
  for (const f of required) out[f] = source[f];
  for (const f of Object.keys(optional)) out[f] = source[f] ?? optional[f];
  return out;
}

/**
 * A session's own metaUpdatedAt if it has one, else falls back through
 * updatedAt then createdAt then 0 -- same chain backup.js/restore.js/
 * azure-sync.js's merge.js all separately rely on so an older record (one
 * from before metaUpdatedAt existed) never compares as `undefined`.
 */
export function sessionMetaUpdatedAt(session) {
  return session.metaUpdatedAt || session.updatedAt || session.createdAt || 0;
}

/** Same fallback chain, for one sentence's updatedAt against its parent session's. */
export function sentenceUpdatedAt(sentence, session) {
  return sentence.updatedAt || session.updatedAt || session.createdAt || 0;
}
