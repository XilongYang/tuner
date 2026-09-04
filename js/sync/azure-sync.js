// syncWithAzure(): bidirectional incremental sync -- merges local IndexedDB
// data with whatever's on Azure at sentence granularity (see ./merge.js),
// uploads/downloads only what changed, writes the merged result back
// locally, then uploads the merged manifest and sweeps orphaned blobs.
// restoreFromAzure(): replaces ALL local history with the Azure backup.
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
import { render } from '../sentence-panel/index.js';
import { applyIncomingSessionUpdate, refreshHistoryTreeIfOpen } from '../history-panel/index.js';
import { setBlobActionStatus } from './panel.js';
import {
  BLOB_MANIFEST_PATH, manifestEtagCache, setManifestEtagCache,
  BLOB_RECORDINGS_PREFIX, blobRecordingPath,
  BLOB_ASSESSMENTS_PREFIX, blobAssessmentPath,
  BLOB_INPUTTEXT_PREFIX, blobInputTextPath,
  cleanupOrphanBlobs,
} from './blob-paths.js';
import { mergeTombstones, mergeById, mergeFolder, mergeSession, survivesTombstone } from './merge.js';

export async function syncWithAzure() {
  const sasUrl = loadBlobSasUrl();
  if (!sasUrl) { alert('Please save a container SAS URL first.'); return; }

  els.backupNowBtn.disabled = true;
  els.restoreNowBtn.disabled = true;
  try {
    setBlobActionStatus('Reading local data…', 'info');
    const { folders: localFolders, sessions: localSessions, tombstones: localTombstones } = await store.exportAll();

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
    // sessionId for inputText) -- used below to avoid re-downloading content
    // we already have, and to find the actual bytes for something we won
    // and need to upload. Three separate maps, one per content kind, all
    // synced the same way (content-addressed by hash, fetched only when the
    // merge decides this device still needs it).
    const localRecordingById = new Map();
    const localAssessmentById = new Map();
    const localInputTextBySession = new Map();
    for (const session of localSessions) {
      if (session.inputText) {
        localInputTextBySession.set(session.id, { text: session.inputText, hash: session.inputTextHash || null });
      }
      for (const s of session.sentences || []) {
        if (s.recordingBlob) {
          localRecordingById.set(`${session.id}/${s.id}`, { blob: s.recordingBlob, hash: s.recordingHash || null });
        }
        if (s.assessment) {
          localAssessmentById.set(`${session.id}/${s.id}`, { json: JSON.stringify(s.assessment), value: s.assessment, hash: s.assessmentHash || null });
        }
      }
    }

    const mergedFolders = mergeById(localFolders, remoteFolders, mergeFolder);
    const mergedSessions = mergeById(localSessions, remoteSessions, mergeSession);

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
        .filter((x) => x.__from === 'remote' && (x.recordingHash || x.assessmentHash)).length;
      const inputTextDownload = s.__metaFrom === 'remote' && s.inputTextHash ? 1 : 0;
      return sum + sentenceDownloads + inputTextDownload;
    }, 0);

    let downloadCount = 0;
    const recordingUploads = [];
    const assessmentUploads = [];
    const inputTextUploads = [];
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

      const sentencesOut = [];
      for (const sentence of session.sentences || []) {
        const key = `${session.id}/${sentence.id}`;
        const localRecording = localRecordingById.get(key);
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
        sentencesOut.push({ ...cleanSentence, recordingBlob, assessment });
      }
      const { __metaFrom, ...cleanSession } = session;
      finalSessions.push({ ...cleanSession, inputText, sentences: sentencesOut });
    }

    for (let i = 0; i < recordingUploads.length; i++) {
      const { sessionId, sentenceId, blob } = recordingUploads[i];
      setBlobActionStatus(`Uploading recording ${i + 1} / ${recordingUploads.length}…`, 'info');
      await blobStore.uploadBytes(sasUrl, blobRecordingPath(sessionId, sentenceId), blob, 'audio/wav');
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
        sentences: (session.sentences || []).map((s) => ({
          id: s.id,
          text: s.text,
          lang: s.lang,
          hidden: s.hidden,
          hasRecording: !!s.recordingHash,
          recordingHash: s.recordingHash || null,
          hasAssessment: !!s.assessmentHash,
          assessmentHash: s.assessmentHash || null,
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
      const assessmentPaths = manifest.sessions.flatMap((session) => (session.sentences || [])
        .filter((s) => s.hasAssessment)
        .map((s) => blobAssessmentPath(session.id, s.id)));
      const inputTextPaths = manifest.sessions
        .filter((session) => session.hasInputText)
        .map((session) => blobInputTextPath(session.id));
      cleanedCount += await cleanupOrphanBlobs(sasUrl, BLOB_RECORDINGS_PREFIX, recordingPaths);
      cleanedCount += await cleanupOrphanBlobs(sasUrl, BLOB_ASSESSMENTS_PREFIX, assessmentPaths);
      cleanedCount += await cleanupOrphanBlobs(sasUrl, BLOB_INPUTTEXT_PREFIX, inputTextPaths);
    } catch (err) {
      cleanupWarning = ` (orphan cleanup skipped: ${err.message})`;
      console.warn('Orphan file cleanup skipped:', err);
    }

    setBlobActionStatus('Saving merged data locally…', 'info');
    await store.upsertFolders(survivingFolders);
    await store.upsertSessions(finalSessions);
    for (const id of casualtySessionIds) await store.removeSessionRecord(id);
    for (const id of casualtyFolderIds) await store.removeFolderRecord(id);
    await store.upsertTombstones(mergedTombstones);

    // If the session currently on screen was deleted by the merge, clear it
    // off-screen (same as "Restore from Azure" does for a destructive
    // change); if it was merely touched, reload it so the visible
    // sentences/scores reflect the merged result. Either way, any
    // not-yet-saved in-flight UI state (e.g. an open word Retest) is
    // discarded -- same tradeoff "Restore from Azure" already makes.
    if (currentSessionId != null) {
      if (casualtySessionIds.has(currentSessionId)) {
        for (const s of sentences) s.recorder.dispose();
        setSentences([]);
        setCurrentSessionId(null);
        els.input.value = '';
        render();
      } else {
        const refreshed = finalSessions.find((s) => s.id === currentSessionId);
        if (refreshed) applyIncomingSessionUpdate(refreshed);
      }
    }
    refreshHistoryTreeIfOpen();

    setBlobActionStatus(
      `Sync complete — ${finalSessions.length} session(s), ${recordingUploads.length + assessmentUploads.length + inputTextUploads.length} uploaded, ${downloadCount} downloaded` +
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

/** Replace ALL local history with whatever is currently backed up on Azure. */
export async function restoreFromAzure() {
  const sasUrl = loadBlobSasUrl();
  if (!sasUrl) { alert('Please save a container SAS URL first.'); return; }
  if (!confirm(
    'This replaces ALL local practice history in this browser with the backup stored on Azure. ' +
    'This cannot be undone. Continue?',
  )) return;

  els.backupNowBtn.disabled = true;
  els.restoreNowBtn.disabled = true;
  try {
    setBlobActionStatus('Downloading manifest\u2026', 'info');
    let manifest;
    try {
      manifest = await blobStore.downloadJson(sasUrl, BLOB_MANIFEST_PATH);
    } catch (err) {
      if (err.notFound) {
        setBlobActionStatus('No backup found on Azure yet \u2014 run "Sync now" first.', 'error');
        return;
      }
      throw err;
    }

    const manifestSessions = manifest.sessions || [];
    // Recordings, assessments and inputText all live as their own blobs now
    // (see syncWithAzure()'s big comment) -- a full restore has to fetch all
    // three kinds, not just recordings.
    const totalDownloads = manifestSessions.reduce((sum, session) => {
      const sentenceDownloads = (session.sentences || [])
        .filter((s) => s.hasRecording || s.hasAssessment).length;
      return sum + sentenceDownloads + (session.hasInputText ? 1 : 0);
    }, 0);

    let downloaded = 0;
    const sessionsOut = [];
    for (const session of manifestSessions) {
      let inputText = '';
      if (session.hasInputText) {
        downloaded++;
        setBlobActionStatus(`Downloading practice text ${downloaded} / ${totalDownloads}\u2026`, 'info');
        const blob = await blobStore.downloadBytes(sasUrl, blobInputTextPath(session.id));
        inputText = await blob.text();
      }

      const sentencesOut = [];
      for (const s of session.sentences || []) {
        let recordingBlob = null;
        if (s.hasRecording) {
          downloaded++;
          setBlobActionStatus(`Downloading recording ${downloaded} / ${totalDownloads}\u2026`, 'info');
          recordingBlob = await blobStore.downloadBytes(sasUrl, blobRecordingPath(session.id, s.id));
        }
        let assessment = null;
        if (s.hasAssessment) {
          downloaded++;
          setBlobActionStatus(`Downloading score ${downloaded} / ${totalDownloads}\u2026`, 'info');
          assessment = await blobStore.downloadJson(sasUrl, blobAssessmentPath(session.id, s.id));
        }
        sentencesOut.push({
          id: s.id,
          text: s.text,
          lang: s.lang,
          hidden: s.hidden,
          assessment,
          recordingBlob,
          recordingHash: s.recordingHash || null,
          assessmentHash: s.assessmentHash || null,
          updatedAt: s.updatedAt || session.updatedAt || session.createdAt || 0,
        });
      }
      sessionsOut.push({
        id: session.id,
        folderId: session.folderId,
        name: session.name,
        inputText,
        inputTextHash: session.inputTextHash || null,
        splitMode: session.splitMode,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        metaUpdatedAt: session.metaUpdatedAt || session.updatedAt || session.createdAt || 0,
        sentences: sentencesOut,
      });
    }

    setBlobActionStatus('Writing to local storage\u2026', 'info');
    await store.restoreSnapshot({ folders: manifest.folders || [], sessions: sessionsOut, tombstones: manifest.tombstones || [] });

    // The restored data lives in IndexedDB now; clear the live screen state
    // (any recordings held only in memory are gone) and let the user pick a
    // session from the (now refreshed) history tree.
    for (const s of sentences) s.recorder.dispose();
    setSentences([]);
    setCurrentSessionId(null);
    els.input.value = '';
    render();
    refreshHistoryTreeIfOpen();

    setBlobActionStatus(
      `Restore complete \u2014 ${sessionsOut.length} session(s), ${totalDownloads} file(s) downloaded.`,
      'recording',
    );
  } catch (err) {
    setBlobActionStatus('Restore failed: ' + err.message, 'error');
  } finally {
    els.backupNowBtn.disabled = false;
    els.restoreNowBtn.disabled = false;
  }
}