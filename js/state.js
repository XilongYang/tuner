// Shared mutable app state: the DOM element cache, the live sentence list,
// the id of the session currently on screen, the global "hide text" default,
// per-sentence "busy" tracking, and the small helpers that read/write them.
// Every other module treats this as the single source of truth for this
// state rather than keeping its own copy.
//
// `sentences`/`currentSessionId`/`globalHideText` are reassigned (not just
// mutated) from several other modules (sentence-panel.js, history-panel.js,
// sync.js, app.js), and only the module that declares an `export let`
// binding may reassign it -- an importer may read the live value but
// assigning to it directly throws. So each is paired with a `setX()`
// function that this module owns and every other module calls instead of
// assigning directly.

import * as store from './store.js';
import { scheduleAutoSync } from './sync.js';

// ---- DOM references ----
const $ = (sel) => document.querySelector(sel);

export const els = {
  input: $('#input-text'),
  splitBtn: $('#split-btn'),
  clearInputBtn: $('#clear-input-btn'),
  splitMode: $('#split-mode'),
  list: $('#sentence-list'),
  count: $('#sentence-count'),
  // Credentials panel
  keyInput: $('#azure-key'),
  regionInput: $('#azure-region'),
  saveKeyBtn: $('#save-key-btn'),
  clearKeyBtn: $('#clear-key-btn'),
  keyStatus: $('#key-status'),
  keyEntry: $('#key-entry'),
  keySaved: $('#key-saved'),
  toggleKeyPanel: $('#toggle-key-panel'),
  keyPanel: $('#key-panel'),
  globalHideInput: $('#global-hide-input'),
  voiceJa: $('#voice-ja'),
  voiceEn: $('#voice-en'),
  // History sidebar
  toggleHistoryPanel: $('#toggle-history-panel'),
  historySidebar: $('#history-sidebar'),
  historyCloseBtn: $('#history-close-btn'),
  newFolderBtn: $('#new-folder-btn'),
  clearHistoryBtn: $('#clear-history-btn'),
  historyTree: $('#history-tree'),
  // Cloud backup (nested inside the Azure settings panel)
  blobSasInput: $('#blob-sas-url'),
  saveBlobBtn: $('#save-blob-btn'),
  clearBlobBtn: $('#clear-blob-btn'),
  blobEntry: $('#blob-entry'),
  blobSaved: $('#blob-saved'),
  blobStatus: $('#blob-status'),
  backupNowBtn: $('#backup-now-btn'),
  restoreNowBtn: $('#restore-now-btn'),
  blobActionStatus: $('#blob-action-status'),
  syncIndicator: $('#sync-indicator'),
  syncIndicatorLabel: $('#sync-indicator-label'),
  syncIndicatorTooltip: $('#sync-indicator-tooltip'),
};

// ---- Global state ----

/** @type {Array<{ id: string, text: string, lang: 'ja'|'en', hidden: boolean, recorder: Recorder, recordingUrl: string|null, recordingBlob: Blob|null, assessment: object|null }>} */
export let sentences = [];
export function setSentences(next) { sentences = next; }

// Global "hide text" switch; the default value for each per-sentence toggle.
export let globalHideText = false;
export function setGlobalHideText(value) { globalHideText = value; }

// ---- Sync "busy" tracking ----
// A sentence is busy while something not yet reflected in IndexedDB is in
// flight for it (a network request) or while it's mid-recording. Automatic
// sync (see scheduleAutoSync() in sync.js) waits out a busy SESSION entirely
// before running at all; a sync that does run (including a manual click)
// still leaves an individual busy SENTENCE's live UI state untouched when
// applying incoming changes (see applyIncomingSessionUpdate() in
// history-panel.js) rather than yanking the row out from under an
// in-progress recording or Retest.
const busySentenceIds = new Set();
export function markSentenceBusy(id) { busySentenceIds.add(id); }
export function unmarkSentenceBusy(id) { busySentenceIds.delete(id); }
export function isSentenceBusy(id) {
  if (busySentenceIds.has(id)) return true;
  const live = sentences.find((s) => s.id === id);
  return !!(live && live.recorder && live.recorder.isRecording);
}
export function isSessionBusy() {
  if (busySentenceIds.size > 0) return true;
  return sentences.some((s) => s.recorder && s.recorder.isRecording);
}

// ---- Local persistence (IndexedDB) ----
// The id of the session currently on screen (one per Split click); null when
// nothing has been split yet, or when saving isn't available in this browser.
export let currentSessionId = null;
export function setCurrentSessionId(id) { currentSessionId = id; }

/** Reduce a sentence to the fields worth persisting (drop the live Recorder). */
export function sentenceToRecord(s) {
  return {
    id: s.id,
    text: s.text,
    lang: s.lang,
    hidden: s.hidden,
    recordingBlob: s.recordingBlob || null,
    // Not recomputed here -- store.js's stampSentenceVersions() hashes the
    // blob itself whenever this comes back null/stale, so it's fine (if the
    // in-memory copy hasn't been told the hash yet) to just pass through
    // whatever we already know.
    recordingHash: s.recordingHash || null,
    assessment: s.assessment || null,
    // Same "pass through whatever we already know" story as recordingHash.
    assessmentHash: s.assessmentHash || null,
  };
}

/** Save the current input text + sentences into the active session, if any. */
export function persistSession() {
  if (currentSessionId == null) return;
  store.updateSession(currentSessionId, {
    inputText: els.input.value,
    splitMode: els.splitMode.value,
    sentences: sentences.map(sentenceToRecord),
  }).then(() => scheduleAutoSync())
    .catch((err) => console.warn('Failed to save session locally:', err));
}

export function formatDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
