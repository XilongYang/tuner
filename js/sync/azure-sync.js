// syncWithAzure(): bidirectional incremental sync -- merges local IndexedDB
// data with whatever's on Azure at sentence granularity (see ./merge.js),
// uploads/downloads only what changed, writes the merged result back
// locally, then uploads the merged manifest and sweeps orphaned blobs. The
// other half of cloud backup, restoreFromAzure() (replace ALL local history
// with the Azure backup), lives in ./restore.js now -- a separate, much
// simpler one-way operation that doesn't belong in the same file as this
// one's incremental merge logic.
//
// Deleting a session or folder IS tracked (js/store/tombstones.js records a
// tombstone on deleteSession()/deleteFolder()) and propagates through sync
// like any other field: survivesTombstone() (./merge.js) only keeps a
// deletion beaten when something edited that same item again afterward.
// Edge case worth knowing: a device that's never directly synced with the
// device that deleted something only learns about the deletion once it
// syncs with a THIRD device that already has -- tombstones spread by riding
// along in the manifest, not by broadcasting, so full convergence can take
// one extra hop in a multi-device chain.

import * as store from '../store/index.js';
import * as blobStore from '../azure-blob.js';
import { loadBlobSasUrl } from '../config.js';
import {
  els, sentences, setSentences, currentSessionId, setCurrentSessionId,
} from '../state.js';
import { setBlobActionStatus } from './panel.js';
import {
  BLOB_MANIFEST_PATH, manifestEtagCache, setManifestEtagCache,
  BLOB_RECORDINGS_PREFIX, blobRecordingPath,
  BLOB_REFERENCES_PREFIX, blobReferencePath,
  BLOB_ASSESSMENTS_PREFIX, blobAssessmentPath,
  BLOB_INPUTTEXT_PREFIX, blobInputTextPath,
  BLOB_SOURCEAUDIO_PREFIX, blobSourceAudioPath,
  cleanupOrphanBlobs,
} from './blob-paths.js';
import { mergeTombstones, mergeById, mergeFolder, mergeSession, survivesTombstone } from './merge.js';
import { uiHooks } from './ui-hooks.js';

// No sentence-panel/history-panel imports in this file by design (F-01 in
// the earlier coupling audit: a sync/data module reaching up into the UI
// layer to trigger repaints is a reverse dependency -- the sync layer has no
// business knowing sentence-panel/history-panel exist). app.js (the
// composition root, the one place already allowed to know about every
// domain) wires the real UI functions into `uiHooks` (./ui-hooks.js) once,
// via setSyncUiHooks(); until wired, they're no-ops -- relevant only to an
// isolated unit test that imports this module directly without going
// through app.js's init().
//
// setBlobActionStatus/els ARE imported directly, though (unlike
// sentence-panel/history-panel's split-actions.js/actions.js pattern, this
// isn't routed through a hook): this file is the sync domain's own
// designated orchestration file -- the one place allowed to mix store/network
// calls with the simple status-text/button-disable UI updates that go with
// them -- exactly like split-actions.js touches els.mergeBtn directly. Only
// the cross-domain UI (repainting sentence-panel/history-panel) goes through
// uiHooks.

/**
 * Which of `sessions` had their LOCAL copy change since `localUpdatedAtAtStart`
 * was captured (syncWithAzure()'s snapshot at the very start of a sync run) --
 * i.e. a local edit (Split, Merge, a recording, anything calling
 * persistSession()) landed while this sync's network round-trip was still in
 * flight, making this sync's already-computed merge stale for that one
 * session. `getSessionFn` is `store.getSession` in production, injectable
 * here so this can be unit-tested without IndexedDB. A session absent from
 * `localUpdatedAtAtStart` is new to local as of this sync round (nothing to
 * race against) and is never considered stale.
 */
export async function findSessionsChangedSinceSnapshot(sessions, localUpdatedAtAtStart, getSessionFn) {
  const staleIds = new Set();
  for (const session of sessions) {
    const startedAt = localUpdatedAtAtStart.get(session.id);
    if (startedAt === undefined) continue;
    const fresh = await getSessionFn(session.id);
    if (!fresh || fresh.updatedAt !== startedAt) staleIds.add(session.id);
  }
  return staleIds;
}

export async function syncWithAzure() {
  const sasUrl = loadBlobSasUrl();
  if (!sasUrl) { alert('Please save a container SAS URL first.'); return; }

  els.backupNowBtn.disabled = true;
  els.restoreNowBtn.disabled = true;
  try {
    setBlobActionStatus('Reading local data…', 'info');
    const { folders: localFolders, sessions: localSessions, tombstones: localTombstones } = await store.exportAll();
    // Snapshot of each session's `updatedAt` at the moment THIS sync started
    // reading -- checked again right before writing the merge result back
    // (see the "Saving merged data locally" step below). A sync round-trips
    // through the network (can take several seconds), so a local edit made
    // WHILE one is in flight -- a Split, a Merge, a recording, anything that
    // calls persistSession() -- is invisible to the merge this sync already
    // computed from the STALE snapshot read here. Without this check, that
    // in-flight sync finishes moments later and overwrites both IndexedDB
    // and the live screen with its now-stale result, silently reverting the
    // edit the user just made -- confirmed in practice: splitting a sentence
    // right as an auto-sync/heartbeat round was already underway.
    const localUpdatedAtAtStart = new Map(localSessions.map((s) => [s.id, s.updatedAt]));

    setBlobActionStatus('Checking remote backup…', 'info');
    // Key order matches the manifest built below (version, folders,
    // tombstones, sessions -- exportedAt aside) so that when nothing exists
    // remotely yet AND there's nothing local either, the no-op check at
    // "nothing changed" below actually short-circuits instead of pointlessly
    // uploading an empty manifest (this matters now that a sync can fire
    // right on page load, before any local data exists).
    let remoteManifest = { version: 4, folders: [], tombstones: [], sessions: [] };
    try {
      const result = await blobStore.downloadJsonConditional(sasUrl, BLOB_MANIFEST_PATH, manifestEtagCache.etag);
      if (result.notModified) {
        // Azure confirmed nothing changed since our cached copy -- reuse it
        // rather than treating "304, no body" as an empty manifest.
        remoteManifest = manifestEtagCache.manifest;
      } else {
        remoteManifest = result.value;
        setManifestEtagCache({ etag: result.etag, manifest: remoteManifest });
      }
    } catch (err) {
      if (!err.notFound) throw err;
      setManifestEtagCache({ etag: null, manifest: null });
    }
    const remoteFolders = remoteManifest.folders || [];
    const remoteSessions = remoteManifest.sessions || [];
    const remoteTombstones = remoteManifest.tombstones || [];

    const mergedTombstones = mergeTombstones(localTombstones, remoteTombstones);
    const tombstoneById = new Map(mergedTombstones.map((t) => [t.id, t]));

    // What we already hold, keyed by "sessionId/sentenceId" (or just
    // sessionId for inputText/sourceAudio) -- used below to avoid
    // re-downloading content we already have, and to find the actual bytes
    // for something we won and need to upload. One map per content kind, all
    // synced the same way (content-addressed by hash, fetched only when the
    // merge decides this device still needs it).
    const localRecordingById = new Map();
    const localReferenceById = new Map();
    const localAssessmentById = new Map();
    const localInputTextBySession = new Map();
    const localSourceAudioBySession = new Map();
    for (const session of localSessions) {
      if (session.inputText) {
        localInputTextBySession.set(session.id, { text: session.inputText, hash: session.inputTextHash || null });
      }
      if (session.sourceAudioBlob) {
        // Same "materialize into a fresh, self-contained Blob right now"
        // reasoning as the recording/reference reads just below.
        const freshBlob = new Blob([await session.sourceAudioBlob.arrayBuffer()], { type: session.sourceAudioBlob.type });
        localSourceAudioBySession.set(session.id, { blob: freshBlob, hash: session.sourceAudioHash || null });
      }
      for (const s of session.sentences || []) {
        // Read the bytes out right now, before any of the (possibly slow)
        // network round-trips below run. A Blob just read out of IndexedDB
        // via store.exportAll() above is backed by a resource tied to that
        // read; refreshSentenceBlobs()'s lazy `new Blob([oldBlob])` rewrap
        // (used everywhere else this app re-stores a Blob) only defers
        // reading it, so it still doesn't protect a Blob that sits around
        // this long -- by the time this function reaches store.upsertSessions()
        // at the end, a whole sync's worth of uploads/downloads later, that
        // resource can already be gone, and IndexedDB's put() then fails with
        // "Error preparing Blob/File data to be stored in object store".
        // Materializing into a fresh, self-contained Blob immediately avoids
        // that regardless of how long the rest of sync takes.
        if (s.recordingBlob) {
          const freshBlob = new Blob([await s.recordingBlob.arrayBuffer()], { type: s.recordingBlob.type });
          localRecordingById.set(`${session.id}/${s.id}`, { blob: freshBlob, hash: s.recordingHash || null });
        }
        if (s.referenceBlob) {
          const freshBlob = new Blob([await s.referenceBlob.arrayBuffer()], { type: s.referenceBlob.type });
          localReferenceById.set(`${session.id}/${s.id}`, { blob: freshBlob, hash: s.referenceHash || null });
        }
        if (s.assessment) {
          localAssessmentById.set(`${session.id}/${s.id}`, { json: JSON.stringify(s.assessment), value: s.assessment, hash: s.assessmentHash || null });
        }
      }
    }

    const mergedFolders = mergeById(localFolders, remoteFolders, mergeFolder);
    // tombstoneById also lets mergeSession() (via mergeSentences() in
    // ./merge.js) drop a sentence that Merge/Split replaced, instead of a
    // sync landing before every device saw the replacement pulling the old
    // sentence right back in alongside the new one -- see mergeSentences()'s
    // doc comment.
    const mergedSessions = mergeById(localSessions, remoteSessions, (l, r) => mergeSession(l, r, tombstoneById));

    // Apply deletions: a tombstone beats a folder's/session's own `updatedAt`
    // unless something edited it again after the delete (see
    // survivesTombstone()'s docs). Everything below works from the survivors
    // only -- including recording downloads, so a session that's being
    // deleted never has its recordings fetched just to throw them away.
    const survivingFolders = mergedFolders.filter((f) => survivesTombstone('folder', f, tombstoneById));
    const survivingSessions = mergedSessions.filter((s) => survivesTombstone('session', s, tombstoneById));
    const casualtyFolderIds = new Set(mergedFolders.filter((f) => !survivesTombstone('folder', f, tombstoneById)).map((f) => f.id));
    const casualtySessionIds = new Set(mergedSessions.filter((s) => !survivesTombstone('session', s, tombstoneById)).map((s) => s.id));

    // A session/folder can end up pointing at a folder that just got deleted
    // above (e.g. it was moved into that folder on a device that never heard
    // about the delete) -- fall back to root rather than leave a dangling
    // reference the History tree can't place.
    const survivingFolderIds = new Set(survivingFolders.map((f) => f.id));
    for (const f of survivingFolders) {
      if (f.parentId != null && !survivingFolderIds.has(f.parentId)) f.parentId = null;
    }
    for (const s of survivingSessions) {
      if (s.folderId != null && !survivingFolderIds.has(s.folderId)) s.folderId = null;
    }

    const totalMaybeDownloads = survivingSessions.reduce((sum, s) => {
      const sentenceDownloads = (s.sentences || [])
        .filter((x) => x.__from === 'remote' && (x.recordingHash || x.referenceHash || x.assessmentHash)).length;
      const inputTextDownload = s.__metaFrom === 'remote' && s.inputTextHash ? 1 : 0;
      const sourceAudioDownload = s.__metaFrom === 'remote' && s.sourceAudioHash ? 1 : 0;
      return sum + sentenceDownloads + inputTextDownload + sourceAudioDownload;
    }, 0);

    let downloadCount = 0;
    const recordingUploads = [];
    const referenceUploads = [];
    const assessmentUploads = [];
    const inputTextUploads = [];
    const sourceAudioUploads = [];
    const finalSessions = [];
    for (const session of survivingSessions) {
      // Session-level content (inputText) -- resolved once per session, not per sentence.
      let inputText = null;
      if (session.inputTextHash) {
        if (session.__metaFrom === 'local') {
          inputText = session.inputText ?? null;
          const remoteSession = remoteSessions.find((rs) => rs.id === session.id);
          const alreadyOnAzure = remoteSession && remoteSession.inputTextHash === session.inputTextHash;
          if (!alreadyOnAzure && inputText != null) {
            inputTextUploads.push({ sessionId: session.id, text: inputText });
          }
        } else {
          const localEntry = localInputTextBySession.get(session.id);
          if (localEntry && localEntry.hash === session.inputTextHash) {
            // Remote won, but we already hold this exact text (likely: ours from an earlier sync).
            inputText = localEntry.text;
          } else {
            downloadCount++;
            setBlobActionStatus(`Downloading practice text ${downloadCount} / ${totalMaybeDownloads}…`, 'info');
            const blob = await blobStore.downloadBytes(sasUrl, blobInputTextPath(session.id));
            inputText = await blob.text();
          }
        }
      }

      // Session-level content (the original audio an import-mode session was
      // sliced from -- state.js's sourceAudioBlob) -- same
      // resolve-once-per-session pattern as inputText just above.
      let sourceAudioBlobResolved = null;
      if (session.sourceAudioHash) {
        if (session.__metaFrom === 'local') {
          const localEntry = localSourceAudioBySession.get(session.id);
          sourceAudioBlobResolved = localEntry ? localEntry.blob : null;
          const remoteSession = remoteSessions.find((rs) => rs.id === session.id);
          const alreadyOnAzure = remoteSession && remoteSession.sourceAudioHash === session.sourceAudioHash;
          if (!alreadyOnAzure && sourceAudioBlobResolved) {
            sourceAudioUploads.push({ sessionId: session.id, blob: sourceAudioBlobResolved });
          }
        } else {
          const localEntry = localSourceAudioBySession.get(session.id);
          if (localEntry && localEntry.hash === session.sourceAudioHash) {
            // Remote won, but we already hold this exact file (likely: ours from an earlier sync).
            sourceAudioBlobResolved = localEntry.blob;
          } else {
            downloadCount++;
            setBlobActionStatus(`Downloading source audio ${downloadCount} / ${totalMaybeDownloads}…`, 'info');
            sourceAudioBlobResolved = await blobStore.downloadBytes(sasUrl, blobSourceAudioPath(session.id));
          }
        }
      }

      const sentencesOut = [];
      for (const sentence of session.sentences || []) {
        const key = `${session.id}/${sentence.id}`;
        const localRecording = localRecordingById.get(key);
        const localReference = localReferenceById.get(key);
        const localAssessmentEntry = localAssessmentById.get(key);
        const remoteSession = remoteSessions.find((rs) => rs.id === session.id);
        const remoteSentence = remoteSession && (remoteSession.sentences || []).find((rs) => rs.id === sentence.id);

        let recordingBlob = null;
        if (sentence.recordingHash) {
          if (sentence.__from === 'local') {
            const alreadyOnAzure = remoteSentence && remoteSentence.recordingHash === sentence.recordingHash;
            recordingBlob = localRecording ? localRecording.blob : null;
            if (!alreadyOnAzure && recordingBlob) {
              recordingUploads.push({ sessionId: session.id, sentenceId: sentence.id, blob: recordingBlob });
            }
          } else if (localRecording && localRecording.hash === sentence.recordingHash) {
            // Remote won, but we already hold that exact take (likely: it's
            // ours from an earlier sync and nothing's changed since).
            recordingBlob = localRecording.blob;
          } else {
            downloadCount++;
            setBlobActionStatus(`Downloading recording ${downloadCount} / ${totalMaybeDownloads}…`, 'info');
            recordingBlob = await blobStore.downloadBytes(sasUrl, blobRecordingPath(session.id, sentence.id));
          }
        }

        // Reference audio (the clip Speak plays -- imported slice or
        // synthesized take) syncs exactly like a recording: same
        // upload-if-local-and-new / reuse-if-hash-matches / download-otherwise
        // logic, just a separate content-addressed blob.
        let referenceBlob = null;
        if (sentence.referenceHash) {
          if (sentence.__from === 'local') {
            const alreadyOnAzure = remoteSentence && remoteSentence.referenceHash === sentence.referenceHash;
            referenceBlob = localReference ? localReference.blob : null;
            if (!alreadyOnAzure && referenceBlob) {
              referenceUploads.push({ sessionId: session.id, sentenceId: sentence.id, blob: referenceBlob });
            }
          } else if (localReference && localReference.hash === sentence.referenceHash) {
            referenceBlob = localReference.blob;
          } else {
            downloadCount++;
            setBlobActionStatus(`Downloading reference audio ${downloadCount} / ${totalMaybeDownloads}…`, 'info');
            referenceBlob = await blobStore.downloadBytes(sasUrl, blobReferencePath(session.id, sentence.id));
          }
        }

        let assessment = null;
        if (sentence.assessmentHash) {
          if (sentence.__from === 'local') {
            const alreadyOnAzure = remoteSentence && remoteSentence.assessmentHash === sentence.assessmentHash;
            assessment = localAssessmentEntry ? localAssessmentEntry.value : (sentence.assessment ?? null);
            if (!alreadyOnAzure && localAssessmentEntry) {
              assessmentUploads.push({ sessionId: session.id, sentenceId: sentence.id, json: localAssessmentEntry.json });
            }
          } else if (localAssessmentEntry && localAssessmentEntry.hash === sentence.assessmentHash) {
            assessment = localAssessmentEntry.value;
          } else {
            downloadCount++;
            setBlobActionStatus(`Downloading score ${downloadCount} / ${totalMaybeDownloads}…`, 'info');
            assessment = await blobStore.downloadJson(sasUrl, blobAssessmentPath(session.id, sentence.id));
          }
        }

        const { __from, ...cleanSentence } = sentence;
        sentencesOut.push({ ...cleanSentence, recordingBlob, referenceBlob, assessment });
      }
      const { __metaFrom, ...cleanSession } = session;
      finalSessions.push({
        ...cleanSession, inputText, sentences: sentencesOut, sourceAudioBlob: sourceAudioBlobResolved,
      });
    }

    for (let i = 0; i < recordingUploads.length; i++) {
      const { sessionId, sentenceId, blob } = recordingUploads[i];
      setBlobActionStatus(`Uploading recording ${i + 1} / ${recordingUploads.length}…`, 'info');
      await blobStore.uploadBytes(sasUrl, blobRecordingPath(sessionId, sentenceId), blob, 'audio/wav');
    }
    for (let i = 0; i < referenceUploads.length; i++) {
      const { sessionId, sentenceId, blob } = referenceUploads[i];
      setBlobActionStatus(`Uploading reference audio ${i + 1} / ${referenceUploads.length}…`, 'info');
      await blobStore.uploadBytes(sasUrl, blobReferencePath(sessionId, sentenceId), blob, blob.type || 'application/octet-stream');
    }
    for (let i = 0; i < assessmentUploads.length; i++) {
      const { sessionId, sentenceId, json } = assessmentUploads[i];
      setBlobActionStatus(`Uploading score ${i + 1} / ${assessmentUploads.length}…`, 'info');
      await blobStore.uploadBytes(sasUrl, blobAssessmentPath(sessionId, sentenceId), new TextEncoder().encode(json), 'application/json');
    }
    for (let i = 0; i < inputTextUploads.length; i++) {
      const { sessionId, text } = inputTextUploads[i];
      setBlobActionStatus(`Uploading practice text ${i + 1} / ${inputTextUploads.length}…`, 'info');
      await blobStore.uploadBytes(sasUrl, blobInputTextPath(sessionId), new TextEncoder().encode(text), 'text/plain; charset=utf-8');
    }
    for (let i = 0; i < sourceAudioUploads.length; i++) {
      const { sessionId, blob } = sourceAudioUploads[i];
      setBlobActionStatus(`Uploading source audio ${i + 1} / ${sourceAudioUploads.length}…`, 'info');
      await blobStore.uploadBytes(sasUrl, blobSourceAudioPath(sessionId), blob, blob.type || 'application/octet-stream');
    }

    // The manifest itself now only carries hashes for these three content
    // kinds, never the content -- an assessment (word/phoneme scores) used
    // to be by far the largest thing embedded here once anything was
    // scored, and inputText duplicated text already spread across
    // `sentences[].text`. Both now live as their own small blobs (uploaded
    // above), fetched only when a merge actually needs them.
    const manifest = {
      version: 4,
      exportedAt: new Date().toISOString(),
      folders: survivingFolders,
      tombstones: mergedTombstones,
      sessions: finalSessions.map((session) => ({
        id: session.id,
        folderId: session.folderId,
        name: session.name,
        splitMode: session.splitMode,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        metaUpdatedAt: session.metaUpdatedAt,
        hasInputText: !!session.inputTextHash,
        inputTextHash: session.inputTextHash || null,
        hasSourceAudio: !!session.sourceAudioHash,
        sourceAudioHash: session.sourceAudioHash || null,
        sentences: (session.sentences || []).map((s) => ({
          id: s.id,
          text: s.text,
          lang: s.lang,
          hidden: s.hidden,
          hasRecording: !!s.recordingHash,
          recordingHash: s.recordingHash || null,
          hasAssessment: !!s.assessmentHash,
          assessmentHash: s.assessmentHash || null,
          hasReference: !!s.referenceHash,
          referenceHash: s.referenceHash || null,
          referenceSource: s.referenceSource || null,
          // Where this clip sits in the session's sourceAudioBlob (small
          // plain values, so -- unlike the blob-backed fields above -- they
          // travel directly in the manifest rather than as their own
          // content-addressed blob; see state.js's doc comment).
          sourceOffsetMs: s.sourceOffsetMs ?? null,
          sourceDurationMs: s.sourceDurationMs ?? null,
          // Azure's per-word timestamps (re-based to this sentence's own
          // text) and any manually-confirmed extra split points -- small
          // plain values like sourceOffsetMs/sourceDurationMs above, so they
          // travel directly in the manifest too. See state.js's doc comment
          // and sentence-panel/split-geometry.js's getSplitPointers().
          words: s.words || null,
          manualPoints: s.manualPoints || null,
          updatedAt: s.updatedAt,
        })),
      })),
    };
    // If the merge produced exactly what's already confirmed live on Azure --
    // the common case for a heartbeat tick where nothing changed on either
    // side -- skip re-uploading a multi-KB blob that would just overwrite
    // itself. Local storage below is still written unconditionally: this
    // only short-circuits the network round-trip. `exportedAt` is excluded
    // from the comparison since it's just an informational "when was this
    // written" stamp that changes on every call regardless of content --
    // comparing it directly would defeat this check every single time.
    const { exportedAt: _manifestExportedAt, ...manifestForCompare } = manifest;
    const { exportedAt: _remoteExportedAt, ...remoteForCompare } = remoteManifest;
    if (JSON.stringify(manifestForCompare) === JSON.stringify(remoteForCompare)) {
      setManifestEtagCache({ etag: manifestEtagCache.etag, manifest });
    } else {
      setBlobActionStatus('Uploading manifest…', 'info');
      const newEtag = await blobStore.uploadJson(sasUrl, BLOB_MANIFEST_PATH, manifest);
      setManifestEtagCache({ etag: newEtag, manifest });
    }

    // Best-effort orphan cleanup, one pass per content kind, using paths
    // referenced by the MERGED manifest -- not just this device's local
    // sessions -- so content only known to some other device doesn't look
    // orphaned from here.
    let cleanedCount = 0;
    let cleanupWarning = '';
    try {
      const recordingPaths = manifest.sessions.flatMap((session) => (session.sentences || [])
        .filter((s) => s.hasRecording)
        .map((s) => blobRecordingPath(session.id, s.id)));
      const referencePaths = manifest.sessions.flatMap((session) => (session.sentences || [])
        .filter((s) => s.hasReference)
        .map((s) => blobReferencePath(session.id, s.id)));
      const assessmentPaths = manifest.sessions.flatMap((session) => (session.sentences || [])
        .filter((s) => s.hasAssessment)
        .map((s) => blobAssessmentPath(session.id, s.id)));
      const inputTextPaths = manifest.sessions
        .filter((session) => session.hasInputText)
        .map((session) => blobInputTextPath(session.id));
      const sourceAudioPaths = manifest.sessions
        .filter((session) => session.hasSourceAudio)
        .map((session) => blobSourceAudioPath(session.id));
      // cleanupOrphanBlobs() itself never touches UI (see its doc comment in
      // blob-paths.js) -- this callback is what actually shows the progress
      // it reports.
      const reportCleanupProgress = (i, total) => setBlobActionStatus(`Removing orphaned file ${i} / ${total}…`, 'info');
      cleanedCount += await cleanupOrphanBlobs(sasUrl, BLOB_RECORDINGS_PREFIX, recordingPaths, reportCleanupProgress);
      cleanedCount += await cleanupOrphanBlobs(sasUrl, BLOB_REFERENCES_PREFIX, referencePaths, reportCleanupProgress);
      cleanedCount += await cleanupOrphanBlobs(sasUrl, BLOB_ASSESSMENTS_PREFIX, assessmentPaths, reportCleanupProgress);
      cleanedCount += await cleanupOrphanBlobs(sasUrl, BLOB_INPUTTEXT_PREFIX, inputTextPaths, reportCleanupProgress);
      cleanedCount += await cleanupOrphanBlobs(sasUrl, BLOB_SOURCEAUDIO_PREFIX, sourceAudioPaths, reportCleanupProgress);
    } catch (err) {
      cleanupWarning = ` (orphan cleanup skipped: ${err.message})`;
      console.warn('Orphan file cleanup skipped:', err);
    }

    setBlobActionStatus('Saving merged data locally…', 'info');
    await store.upsertFolders(survivingFolders);

    // Re-check each surviving session's local `updatedAt` right now,
    // immediately before writing -- see localUpdatedAtAtStart's doc comment
    // above for why: if it moved since this sync started reading (a local
    // edit -- a Split, a Merge, anything that calls persistSession() --
    // landed while this sync's network round-trip was in flight), this
    // sync's merge was computed from an already-stale snapshot for that one
    // session. Skip writing/applying it this round rather than clobbering
    // the newer local edit with it; the next auto-sync (already scheduled
    // by that same persistSession() call) will merge it correctly against
    // whatever's now on Azure.
    const staleSessionIds = await findSessionsChangedSinceSnapshot(finalSessions, localUpdatedAtAtStart, store.getSession);
    if (staleSessionIds.size) {
      console.warn(`Sync: ${staleSessionIds.size} session(s) changed locally while this sync was in flight -- skipping this round's write for them; the next sync will pick them up.`);
    }
    const sessionsToWrite = staleSessionIds.size
      ? finalSessions.filter((s) => !staleSessionIds.has(s.id))
      : finalSessions;

    await store.upsertSessions(sessionsToWrite);
    for (const id of casualtySessionIds) await store.removeSessionRecord(id);
    for (const id of casualtyFolderIds) await store.removeFolderRecord(id);
    await store.upsertTombstones(mergedTombstones);

    // If the session currently on screen was deleted by the merge, clear it
    // off-screen (same as "Restore from Azure" does for a destructive
    // change); if it was merely touched, reload it so the visible
    // sentences/scores reflect the merged result -- unless it's one of the
    // stale sessions just skipped above, in which case the screen already
    // shows the newer local edit and must be left alone. Either way, any
    // not-yet-saved in-flight UI state (e.g. an open word Retest) is
    // discarded -- same tradeoff "Restore from Azure" already makes.
    if (currentSessionId != null) {
      if (casualtySessionIds.has(currentSessionId)) {
        for (const s of sentences) s.recorder.dispose();
        setSentences([]);
        setCurrentSessionId(null);
        els.input.value = '';
        uiHooks.render();
      } else if (!staleSessionIds.has(currentSessionId)) {
        const refreshed = finalSessions.find((s) => s.id === currentSessionId);
        if (refreshed) uiHooks.applyIncomingSessionUpdate(refreshed);
      }
    }
    uiHooks.refreshHistoryTreeIfOpen();

    setBlobActionStatus(
      `Sync complete — ${finalSessions.length} session(s), ${recordingUploads.length + referenceUploads.length + assessmentUploads.length + inputTextUploads.length} uploaded, ${downloadCount} downloaded` +
      (casualtySessionIds.size || casualtyFolderIds.size
        ? `, ${casualtySessionIds.size} session(s)/${casualtyFolderIds.size} folder(s) deleted`
        : '') +
      (cleanedCount ? `, ${cleanedCount} orphan recording(s) removed` : '') +
      `.${cleanupWarning}`,
      cleanupWarning ? 'error' : 'recording',
    );
  } catch (err) {
    setBlobActionStatus('Sync failed: ' + err.message, 'error');
  } finally {
    els.backupNowBtn.disabled = false;
    els.restoreNowBtn.disabled = false;
  }
}

