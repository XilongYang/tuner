// Content hashing for recordings/assessments/input text, and stamping each
// sentence with a per-sentence `updatedAt` that cloud sync merges on.

/**
 * A Blob read back out of IndexedDB can't always be handed straight back into
 * a later `put()` as-is -- Chromium has a long-standing bug ("Error preparing
 * Blob/File data to be stored in object store") when an already-stored Blob
 * is re-serialized into a *different* transaction, which is exactly what
 * every read-then-write in this file below does (rename, move, reparent on
 * folder delete). Rewrapping it as a fresh in-memory Blob first sidesteps it;
 * this is cheap (no data is copied/read eagerly) and a no-op for blobs that
 * were never touched.
 */
export function refreshSentenceBlobs(sentences) {
  if (!Array.isArray(sentences)) return sentences;
  return sentences.map((s) => (
    s && s.recordingBlob
      ? { ...s, recordingBlob: new Blob([s.recordingBlob], { type: s.recordingBlob.type }) }
      : s
  ));
}

/**
 * SHA-256 of a recording's bytes, as a stand-in for the Blob itself in version
 * comparisons -- refreshSentenceBlobs() above rewraps every recordingBlob into
 * a brand-new Blob instance on every single save (to dodge the Chromium
 * re-store bug), so comparing recordings by object identity or reference is
 * never meaningful here. A cheap hash is the only reliable "did this actually
 * change" signal, and it doubles as the value cloud sync uses to skip
 * re-uploading/re-downloading a recording that's already present unchanged.
 */
async function hashBytes(bufferSource) {
  const digest = await crypto.subtle.digest('SHA-256', bufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashBlob(blob) {
  return hashBytes(await blob.arrayBuffer());
}

/**
 * Same idea as hashBlob(), for the other two "big, mostly-static" payloads
 * that used to be embedded directly in the Azure manifest: a sentence's
 * assessment (word/phoneme-level scores -- by far the largest thing in the
 * old manifest once anything's been scored) and a session's inputText. Both
 * now sync as their own small content-addressed blobs (js/app.js's
 * syncWithAzure()), with only the hash living in the manifest, the same
 * relationship recordings already had to `recordingHash`.
 */
export function hashString(str) {
  return hashBytes(new TextEncoder().encode(str));
}

/**
 * Stamp each incoming sentence with a per-sentence `updatedAt`, bumping it only
 * for sentences whose sync-relevant fields (hidden / assessment / recording)
 * actually changed relative to what's currently stored -- this is the version
 * signal cloud sync merges on, at sentence granularity, so editing sentence 3
 * must never touch sentence 1's timestamp (and so, in a merge, never make
 * sentence 1 look newer than it is).
 *
 * recordingHash/assessmentHash are ALWAYS recomputed fresh from the actual
 * content here, never trusted from whatever the incoming sentence happens to
 * carry -- a caller that does `{ ...oldSentence, assessment: newValue }` (the
 * ordinary immutable-update pattern) still has the OLD hash sitting on the
 * object even though the content changed, and trusting that stale hash would
 * silently break both the hash itself and the `changed` check below (which
 * used to compare hashes rather than content for exactly this reason -- see
 * git history if this comment still exists next to that mistake). Hashing a
 * short WAV/JSON payload is cheap enough that "recompute every save" is not
 * worth optimizing away.
 *
 * Known gap: sentences are never added to or removed from a session after
 * Split (see js/app.js's handleSplit) -- so this only has to reconcile
 * field-level edits, never a sentence's disappearance. It also does not (and
 * cannot, without a tombstone) detect a whole *session* being deleted; a sync
 * merge will just see it as "session doesn't exist on this side yet" and
 * bring it back from whichever side still has it.
 */
export async function stampSentenceVersions(existingSentences, incomingSentences) {
  if (!Array.isArray(incomingSentences)) return incomingSentences;
  const existingById = new Map((existingSentences || []).map((s) => [s.id, s]));
  const now = Date.now();
  return Promise.all(incomingSentences.map(async (s) => {
    const prev = existingById.get(s.id);

    const recordingHash = s.recordingBlob ? await hashBlob(s.recordingBlob) : null;
    const recordingChanged = (prev?.recordingHash || null) !== (recordingHash || null);

    const assessmentHash = s.assessment ? await hashString(JSON.stringify(s.assessment)) : null;
    const assessmentChanged = (prev?.assessmentHash || null) !== (assessmentHash || null);

    if (!prev) return { ...s, recordingHash, assessmentHash, updatedAt: s.updatedAt ?? now };
    const changed =
      prev.text !== s.text ||
      prev.lang !== s.lang ||
      prev.hidden !== s.hidden ||
      recordingChanged ||
      assessmentChanged;
    return { ...s, recordingHash, assessmentHash, updatedAt: changed ? now : (prev.updatedAt ?? now) };
  }));
}
