// Blob path helpers for the three content kinds sync stores individually
// (recordings / assessments / input text -- see the big comment on
// syncWithAzure() in ./azure-sync.js for why), the manifest path, the
// in-memory manifest-ETag cache, and best-effort orphan-blob cleanup shared
// by all three kinds.

import * as blobStore from '../azure-blob.js';
import { setBlobActionStatus } from './panel.js';

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

/**
 * Delete any blob under `prefix` that the current sync no longer references
 * (e.g. its session was deleted, or a sentence's recording/assessment/a
 * session's inputText was replaced by a newer take since the last sync).
 * Shared by all three content kinds above -- same cleanup logic, just a
 * different prefix and reference set each time. Best-effort: a missing
 * List/Delete permission on the SAS token, or any other failure, is left for
 * the caller to report as a warning rather than fail the whole sync -- the
 * manifest + uploads before this point already succeeded.
 */
export async function cleanupOrphanBlobs(sasUrl, prefix, referencedPaths) {
  const allBlobs = await blobStore.listBlobs(sasUrl, prefix);
  const referenced = new Set(referencedPaths);
  const orphans = allBlobs.filter((name) => !referenced.has(name));
  for (let i = 0; i < orphans.length; i++) {
    setBlobActionStatus(`Removing orphaned file ${i + 1} / ${orphans.length}\u2026`, 'info');
    await blobStore.deleteBlob(sasUrl, orphans[i]);
  }
  return orphans.length;
}