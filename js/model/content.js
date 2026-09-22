// Every blob-backed piece of content in the app, described once.
//
// "Content" is anything whose bytes are too big to travel inline: the user's
// recording of a sentence, the reference clip Speak plays, an Azure
// assessment result, a session's practice text, the original audio file an
// imported session was sliced from, a vocab occurrence's standalone clip.
// They differ in scope (what owns them), where their bytes live, and how
// bytes convert to and from a value -- and in nothing else. Sync and orphan
// cleanup iterate this table rather than branching per kind, so a new kind is
// one row here plus one `f.content()` field in ./schema.js.
//
// `scope` names the owner shape a ref carries:
//   'session'    -> { sessionId }
//   'sentence'   -> { sessionId, sentenceId }
//   'occurrence' -> { audioPathKey, occurrenceId }   (vocab; see below)
//
// A vocab occurrence is keyed by audioPathKey/occurrenceId rather than by the
// session and sentence it was recorded from, because those may since have
// been edited, split, merged or deleted while the occurrence remains valid.

/** @typedef {'session'|'sentence'|'occurrence'} Scope */

/**
 * @typedef {object} ContentKind
 * @property {Scope} scope
 * @property {string} prefix       Blob-path prefix; also the cleanup sweep root.
 * @property {(ref: object) => string} path   Blob path for one ref, prefix included.
 * @property {string} mime         Content-Type used when uploading.
 * @property {'bytes'|'text'|'json'} encoding  How bytes convert to a value.
 */

/**
 * The blob path always ends in a fixed extension per kind, chosen for
 * recognisability when browsing the container by hand; playback never relies
 * on it (a Blob carries its own type, taken from the response's
 * Content-Type), so an imported clip that is actually mp3-derived living at
 * `.audio` is correct, not a mismatch.
 * @type {Record<string, ContentKind>}
 */
export const CONTENT_KINDS = {
  recording: {
    scope: 'sentence',
    prefix: 'recordings/',
    path: (r) => `recordings/${r.sessionId}/${r.sentenceId}.wav`,
    mime: 'audio/wav',
    encoding: 'bytes',
  },
  reference: {
    scope: 'sentence',
    prefix: 'references/',
    path: (r) => `references/${r.sessionId}/${r.sentenceId}.audio`,
    mime: 'application/octet-stream',
    encoding: 'bytes',
  },
  assessment: {
    scope: 'sentence',
    prefix: 'assessments/',
    path: (r) => `assessments/${r.sessionId}/${r.sentenceId}.json`,
    mime: 'application/json',
    encoding: 'json',
  },
  inputText: {
    scope: 'session',
    prefix: 'inputtext/',
    path: (r) => `inputtext/${r.sessionId}.txt`,
    mime: 'text/plain; charset=utf-8',
    encoding: 'text',
  },
  sourceAudio: {
    scope: 'session',
    prefix: 'sourceaudio/',
    path: (r) => `sourceaudio/${r.sessionId}.audio`,
    mime: 'application/octet-stream',
    encoding: 'bytes',
  },
  vocabAudio: {
    scope: 'occurrence',
    prefix: 'vocab-audio/',
    path: (r) => `vocab-audio/${r.audioPathKey}/${r.occurrenceId}.audio`,
    mime: 'application/octet-stream',
    encoding: 'bytes',
  },
};

/** Throws rather than returning undefined: an unknown kind is a caller bug, and
 *  silently skipping one would lose content without an error anywhere. */
export function contentKind(name) {
  const kind = CONTENT_KINDS[name];
  if (!kind) throw new Error(`Unknown content kind: ${name}`);
  return kind;
}

/**
 * The path an interpolated ref component contributes, checked.
 *
 * A path is an address: every read, every upload, every sweep of orphaned
 * bytes goes through one. A ref missing a component would interpolate as the
 * string "undefined" and produce a path that is well-formed, wrong, and the
 * same wrong path on every device -- content written under it is content
 * nobody can find, and the sweep would collect the real bytes as orphans. So a
 * missing component is refused where it is noticed rather than addressed.
 */
function checked(name, ref, path) {
  if (path.includes('undefined') || path.includes('null')) {
    throw new Error(`Cannot address ${name} content: ref is missing a part (${JSON.stringify(ref)})`);
  }
  return path;
}

export function contentPath(name, ref) {
  return checked(name, ref, contentKind(name).path(ref));
}
