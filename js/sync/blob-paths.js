// Blob path helpers for the content kinds sync stores individually
// (recordings / references / assessments / input text / a session's source
// audio -- see the big comment on syncWithAzure() in ./azure-sync.js for
// why), the manifest path, the in-memory manifest-ETag cache, and
// best-effort orphan-blob cleanup shared by all of them.

import * as blobStore from '../azure-blob.js';

export const BLOB_MANIFEST_PATH = 'tuner/manifest.json';

// In-memory cache of the manifest ETag/content we last confirmed matches
// what's on Azure -- lets a heartbeat sync (usually finding nothing changed
// anywhere) skip re-downloading and re-parsing the whole manifest via a
// conditional GET, and skip re-uploading it too when the freshly merged
// result is byte-identical to what's already there. Cleared implicitly on
// page reload (it's just a module-level variable); the first sync after a
// reload pays for one real GET, same as before this existed.
export let manifestEtagCache = { etag: null, manifest: null };
export function setManifestEtagCache(v) {
  manifestEtagCache = v;
}

export const BLOB_RECORDINGS_PREFIX = 'tuner/recordings/';
export const blobRecordingPath = (sessionId, sentenceId) => `${BLOB_RECORDINGS_PREFIX}${sessionId}/${sentenceId}.wav`;

// A sentence's reference clip (the audio Speak plays -- an imported slice, or
// a persisted synthesized take) syncs the same way a recording does: its own
// small content-addressed blob, only a hash living in the manifest. The
// actual bytes' format varies (wav for an imported slice, mp3 for a
// synthesized one), but the path extension is just for tidiness in the
// container -- playback always relies on the Blob's own `type`, set from the
// upload's Content-Type header (see uploadBytes()/downloadBytes() in
// ../azure-blob.js), never the URL.
export const BLOB_REFERENCES_PREFIX = 'tuner/references/';
export const blobReferencePath = (sessionId, sentenceId) => `${BLOB_REFERENCES_PREFIX}${sessionId}/${sentenceId}.audio`;

// A sentence's assessment (word/phoneme-level scores -- by far the largest
// thing in the old, fully-embedded manifest once anything's been scored) and
// a session's inputText each sync as their own small content-addressed blob,
// exactly like a recording: only a hash lives in the manifest, the actual
// content is fetched separately and only when the merge decides this device
// still needs it (see resolveSentenceContent()/resolveSessionInputText()
// inside syncWithAzure()).
export const BLOB_ASSESSMENTS_PREFIX = 'tuner/assessments/';
export const blobAssessmentPath = (sessionId, sentenceId) => `${BLOB_ASSESSMENTS_PREFIX}${sessionId}/${sentenceId}.json`;
export const BLOB_INPUTTEXT_PREFIX = 'tuner/inputtext/';
export const blobInputTextPath = (sessionId) => `${BLOB_INPUTTEXT_PREFIX}${sessionId}.txt`;

// An audio-imported session's original source file (session.sourceAudioBlob
// -- see its doc comment in state.js), kept around so Split/Merge can always
// re-slice a fresh, lossless clip instead of compounding error through an
// already-derived one. One per session (not per sentence), syncs exactly
// like inputText above: a single content-addressed blob, only its hash
// living in the manifest.
export const BLOB_SOURCEAUDIO_PREFIX = 'tuner/sourceaudio/';
export const blobSourceAudioPath = (sessionId) => `${BLOB_SOURCEAUDIO_PREFIX}${sessionId}.audio`;

/**
 * Which blob paths a manifest's `sessions` array (the shape syncWithAzure()
 * builds -- see its `manifest` object) references, split into the same five
 * content kinds cleanupOrphanBlobs() is called for once each. Factored out
 * so it can be computed twice in a row against two different manifest
 * snapshots -- see syncWithAzure()'s orphan-cleanup step for why: the
 * manifest a sync itself just wrote is already some seconds old by the time
 * cleanup actually runs, and previously that snapshot was the ONLY thing
 * cleanup checked against -- so a blob another device finished uploading (and
 * referenced in its own, newer manifest) in that window looked like an
 * orphan here and got deleted, silently, moments after that other device's
 * sync had reported success. Re-fetching the manifest fresh immediately
 * before deleting anything, and treating BOTH snapshots' references as
 * live, closes that window down to the (much shorter) gap between the
 * re-fetch and the delete calls themselves.
 */
export function referencedBlobPaths(manifestSessions) {
  const sessions = manifestSessions || [];
  return {
    recordingPaths: sessions.flatMap((session) => (session.sentences || [])
      .filter((s) => s.hasRecording)
      .map((s) => blobRecordingPath(session.id, s.id))),
    referencePaths: sessions.flatMap((session) => (session.sentences || [])
      .filter((s) => s.hasReference)
      .map((s) => blobReferencePath(session.id, s.id))),
    assessmentPaths: sessions.flatMap((session) => (session.sentences || [])
      .filter((s) => s.hasAssessment)
      .map((s) => blobAssessmentPath(session.id, s.id))),
    inputTextPaths: sessions
      .filter((session) => session.hasInputText)
      .map((session) => blobInputTextPath(session.id)),
    sourceAudioPaths: sessions
      .filter((session) => session.hasSourceAudio)
      .map((session) => blobSourceAudioPath(session.id)),
  };
}

/**
 * Delete any blob under `prefix` that the current sync no longer references
 * (e.g. its session was deleted, or a sentence's recording/assessment/a
 * session's inputText was replaced by a newer take since the last sync).
 * Shared by every content kind above -- same cleanup logic, just a
 * different prefix and reference set each time. Best-effort: a missing
 * List/Delete permission on the SAS token, or any other failure, is left for
 * the caller to report as a warning rather than fail the whole sync -- the
 * manifest + uploads before this point already succeeded.
 *
 * `onProgress`, if given, is called as `onProgress(current, total)` before
 * each delete -- this file is otherwise pure network/data logic with no UI
 * access of its own (previously it imported setBlobActionStatus from
 * ./panel.js directly to report this progress itself, the exact
 * data-module-reaching-into-UI coupling this callback replaces); the caller
 * (azure-sync.js) decides what, if anything, to show for that progress.
 */
export async function cleanupOrphanBlobs(sasUrl, prefix, referencedPaths, onProgress) {
  const allBlobs = await blobStore.listBlobs(sasUrl, prefix);
  const referenced = new Set(referencedPaths);
  const orphans = allBlobs.filter((name) => !referenced.has(name));
  for (let i = 0; i < orphans.length; i++) {
    onProgress?.(i + 1, orphans.length);
    await blobStore.deleteBlob(sasUrl, orphans[i]);
  }
  return orphans.length;
}