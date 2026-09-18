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
  blobVocabAudioPath,
} from './blob-paths.js';
import { uiHooks } from './ui-hooks.js';
import {
  SESSION_FIELDS, SESSION_OPTIONAL_FIELDS,
  SENTENCE_FIELDS, SENTENCE_OPTIONAL_FIELDS,
  VOCAB_ENTRY_FIELDS, VOCAB_SOURCE_FIELDS, VOCAB_SOURCE_OPTIONAL_FIELDS,
  pickFields, sessionMetaUpdatedAt, sentenceUpdatedAt,
} from '../store/entity-schema.js';

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
    const manifestVocab = manifest.vocab || [];
    // Recordings, assessments, inputText, sourceAudio, and vocab occurrence
    // audio all live as their own blobs now (see azure-sync.js's
    // syncWithAzure() big comment) -- a full restore has to fetch every
    // kind, not just recordings.
    const totalDownloads = manifestSessions.reduce((sum, session) => {
      const sentenceDownloads = (session.sentences || [])
        .filter((s) => s.hasRecording || s.hasReference || s.hasAssessment).length;
      return sum + sentenceDownloads + (session.hasInputText ? 1 : 0) + (session.hasSourceAudio ? 1 : 0);
    }, 0) + manifestVocab.reduce((sum, entry) => sum + (entry.sources || []).filter((s) => s.hasAudio).length, 0);

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
          ...pickFields(s, SENTENCE_FIELDS, SENTENCE_OPTIONAL_FIELDS),
          assessment,
          recordingBlob,
          referenceBlob,
          updatedAt: sentenceUpdatedAt(s, session),
        });
      }
      sessionsOut.push({
        ...pickFields(session, SESSION_FIELDS, SESSION_OPTIONAL_FIELDS),
        inputText,
        metaUpdatedAt: sessionMetaUpdatedAt(session),
        sentences: sentencesOut,
        sourceAudioBlob,
      });
    }

    const vocabOut = [];
    for (const entry of manifestVocab) {
      const sourcesOut = [];
      for (const s of entry.sources || []) {
        let audioBlob = null;
        if (s.hasAudio) {
          downloaded++;
          setBlobActionStatus(`Downloading vocab audio ${downloaded} / ${totalDownloads}…`, 'info');
          audioBlob = await blobStore.downloadBytes(sasUrl, blobVocabAudioPath(entry.audioPathKey, s.occurrenceId));
        }
        sourcesOut.push({
          ...pickFields(s, VOCAB_SOURCE_FIELDS, VOCAB_SOURCE_OPTIONAL_FIELDS),
          hasAudio: s.hasAudio,
          audioBlob,
        });
      }
      vocabOut.push({
        ...pickFields(entry, VOCAB_ENTRY_FIELDS),
        sources: sourcesOut,
      });
    }

    setBlobActionStatus('Writing to local storage…', 'info');
    await store.restoreSnapshot({
      folders: manifest.folders || [], sessions: sessionsOut, vocab: vocabOut, tombstones: manifest.tombstones || [],
    });

    // The restored data lives in IndexedDB now; clear the live screen state
    // (any recordings held only in memory are gone) and let the user pick a
    // session from the (now refreshed) history tree.
    for (const s of sentences) s.recorder.dispose();
    setSentences([]);
    setCurrentSessionId(null);
    els.input.value = '';
    uiHooks.render();
    uiHooks.refreshHistoryTreeIfOpen();
    uiHooks.refreshVocabPanelIfOpen();

    setBlobActionStatus(
      `Restore complete — ${sessionsOut.length} session(s), ${vocabOut.length} vocab entr${vocabOut.length === 1 ? 'y' : 'ies'}, ${totalDownloads} file(s) downloaded.`,
      'recording',
    );
  } catch (err) {
    setBlobActionStatus('Restore failed: ' + err.message, 'error');
  } finally {
    els.backupNowBtn.disabled = false;
    els.restoreNowBtn.disabled = false;
  }
}
