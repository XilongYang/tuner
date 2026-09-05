// restoreFromAzure(): replace ALL local history with whatever is currently
// backed up on Azure -- a full one-way download, the destructive counterpart
// to azure-sync.js's incremental bidirectional syncWithAzure(). Split into
// its own file since the two don't share any logic beyond the blob-path
// helpers and manifest shape (./blob-paths.js) and the post-sync UI callbacks
// (./ui-hooks.js) -- keeping them in one file just because both talk to
// Azure was cohesion in name only.

import * as store from '../store/index.js';
import * as blobStore from '../azure-blob.js';
import { loadBlobSasUrl } from '../config.js';
import {
  els, sentences, setSentences, setCurrentSessionId,
} from '../state.js';
import { setBlobActionStatus } from './panel.js';
import {
  BLOB_MANIFEST_PATH,
  blobRecordingPath, blobReferencePath, blobAssessmentPath, blobInputTextPath, blobSourceAudioPath,
} from './blob-paths.js';
import { uiHooks } from './ui-hooks.js';

// No sentence-panel/history-panel imports here either -- same reasoning as
// azure-sync.js's module comment (F-01): app.js wires the real render()/
// refreshHistoryTreeIfOpen() into uiHooks (./ui-hooks.js) once, this file
// only ever calls the shared uiHooks object. setBlobActionStatus/els are
// imported directly, same as azure-sync.js -- this file is its own
// designated orchestration entry point for the "restore" operation, allowed
// to mix the store/network calls with the status-text/button-disable UI that
// goes with them.
//
// Circular with panel.js (this file imports setBlobActionStatus from there,
// while panel.js imports restoreFromAzure from here to wire the "Restore
// from Azure" button) -- safe, same as the rest of this codebase's cycles:
// both sides only call into each other from inside functions, never at
// module-evaluation time.

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
    setBlobActionStatus('Downloading manifest…', 'info');
    let manifest;
    try {
      manifest = await blobStore.downloadJson(sasUrl, BLOB_MANIFEST_PATH);
    } catch (err) {
      if (err.notFound) {
        setBlobActionStatus('No backup found on Azure yet — run "Sync now" first.', 'error');
        return;
      }
      throw err;
    }

    const manifestSessions = manifest.sessions || [];
    // Recordings, assessments, inputText and sourceAudio all live as their
    // own blobs now (see azure-sync.js's syncWithAzure() big comment) -- a
    // full restore has to fetch all four kinds, not just recordings.
    const totalDownloads = manifestSessions.reduce((sum, session) => {
      const sentenceDownloads = (session.sentences || [])
        .filter((s) => s.hasRecording || s.hasReference || s.hasAssessment).length;
      return sum + sentenceDownloads + (session.hasInputText ? 1 : 0) + (session.hasSourceAudio ? 1 : 0);
    }, 0);

    let downloaded = 0;
    const sessionsOut = [];
    for (const session of manifestSessions) {
      let inputText = '';
      if (session.hasInputText) {
        downloaded++;
        setBlobActionStatus(`Downloading practice text ${downloaded} / ${totalDownloads}…`, 'info');
        const blob = await blobStore.downloadBytes(sasUrl, blobInputTextPath(session.id));
        inputText = await blob.text();
      }

      let sourceAudioBlob = null;
      if (session.hasSourceAudio) {
        downloaded++;
        setBlobActionStatus(`Downloading source audio ${downloaded} / ${totalDownloads}…`, 'info');
        sourceAudioBlob = await blobStore.downloadBytes(sasUrl, blobSourceAudioPath(session.id));
      }

      const sentencesOut = [];
      for (const s of session.sentences || []) {
        let recordingBlob = null;
        if (s.hasRecording) {
          downloaded++;
          setBlobActionStatus(`Downloading recording ${downloaded} / ${totalDownloads}…`, 'info');
          recordingBlob = await blobStore.downloadBytes(sasUrl, blobRecordingPath(session.id, s.id));
        }
        let referenceBlob = null;
        if (s.hasReference) {
          downloaded++;
          setBlobActionStatus(`Downloading reference audio ${downloaded} / ${totalDownloads}…`, 'info');
          referenceBlob = await blobStore.downloadBytes(sasUrl, blobReferencePath(session.id, s.id));
        }
        let assessment = null;
        if (s.hasAssessment) {
          downloaded++;
          setBlobActionStatus(`Downloading score ${downloaded} / ${totalDownloads}…`, 'info');
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
          referenceBlob,
          referenceHash: s.referenceHash || null,
          referenceSource: s.referenceSource || null,
          sourceOffsetMs: s.sourceOffsetMs ?? null,
          sourceDurationMs: s.sourceDurationMs ?? null,
          words: s.words || null,
          manualPoints: s.manualPoints || null,
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
        sourceAudioBlob,
        sourceAudioHash: session.sourceAudioHash || null,
      });
    }

    setBlobActionStatus('Writing to local storage…', 'info');
    await store.restoreSnapshot({ folders: manifest.folders || [], sessions: sessionsOut, tombstones: manifest.tombstones || [] });

    // The restored data lives in IndexedDB now; clear the live screen state
    // (any recordings held only in memory are gone) and let the user pick a
    // session from the (now refreshed) history tree.
    for (const s of sentences) s.recorder.dispose();
    setSentences([]);
    setCurrentSessionId(null);
    els.input.value = '';
    uiHooks.render();
    uiHooks.refreshHistoryTreeIfOpen();

    setBlobActionStatus(
      `Restore complete — ${sessionsOut.length} session(s), ${totalDownloads} file(s) downloaded.`,
      'recording',
    );
  } catch (err) {
    setBlobActionStatus('Restore failed: ' + err.message, 'error');
  } finally {
    els.backupNowBtn.disabled = false;
    els.restoreNowBtn.disabled = false;
  }
}
