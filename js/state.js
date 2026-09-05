// Shared mutable app state: the DOM element cache, the live sentence list,
// the id of the session currently on screen, the global "hide text" default,
// per-sentence "busy" tracking, and the small helpers that read/write them.
// Every other module treats this as the single source of truth for this
// state rather than keeping its own copy.
//
// `sentences`/`currentSessionId`/`globalHideText` are reassigned (not just
// mutated) from several other modules (js/sentence-panel/, js/history-panel/,
// js/sync/, app.js), and only the module that declares an `export let`
// binding may reassign it -- an importer may read the live value but
// assigning to it directly throws. So each is paired with a `setX()`
// function that this module owns and every other module calls instead of
// assigning directly.

import * as store from './store/index.js';
import { scheduleAutoSync } from './sync/index.js';

// ---- DOM references ----
const $ = (sel) => document.querySelector(sel);

export const els = {
  input: $('#input-text'),
  inputLabel: $('#input-label'),
  inputMaskWrap: $('#input-mask-wrap'),
  splitBtn: $('#split-btn'),
  clearInputBtn: $('#clear-input-btn'),
  list: $('#sentence-list'),
  count: $('#sentence-count'),
  audioImportBtn: $('#audio-import-btn'),
  audioImportInput: $('#audio-import-input'),
  audioImportStatus: $('#audio-import-status'),
  inputMaskOverlay: $('#input-mask-overlay'),
  mergeBar: $('#merge-bar'),
  mergeBarLabel: $('#merge-bar-label'),
  mergeBtn: $('#merge-btn'),
  mergeCancelBtn: $('#merge-cancel-btn'),
  // Credentials panel
  keyInput: $('#azure-key'),
  regionInput: $('#azure-region'),
  resourceNameInput: $('#azure-resource-name'),
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
  exportHistoryBtn: $('#export-history-btn'),
  importHistoryBtn: $('#import-history-btn'),
  importHistoryInput: $('#import-history-input'),
  clearHistoryBtn: $('#clear-history-btn'),
  historyIoStatus: $('#history-io-status'),
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

/**
 * Rebuild #input-mask-overlay's content from #input-text's current value:
 * every non-whitespace character becomes a literal "#", whitespace/newlines
 * are kept as-is so the redacted shape still lines up with the real text's
 * line breaks and word spacing (see .input-masked / #input-mask-overlay in
 * css/input-area.css). Purely visual -- els.input.value itself is never touched
 * here. Every place that assigns els.input.value should call this
 * afterwards so the overlay never goes stale.
 */
export function refreshInputMaskOverlay() {
  if (!els.inputMaskOverlay) return;
  els.inputMaskOverlay.textContent = Array.from(els.input.value)
    .map((ch) => (/\s/.test(ch) ? ch : '#'))
    .join('');
}

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

// Which flow produced the sentences currently on screen: 'auto' (a plain text
// Split) or 'audio' (Import audio). No longer a user-facing choice -- the old
// "Split by /" manual mode and its dropdown were removed -- this just tracks
// session.splitMode internally now that there's no <select> to read it from,
// so the input box can be locked read-only and Split's meaning switched (see
// applyAudioSessionLock()/handleAudioResplit() in sentence-panel/split.js)
// for a session that came from an audio import.
export let currentSplitMode = 'auto';
export function setCurrentSplitMode(mode) { currentSplitMode = mode || 'auto'; }

// The ORIGINAL audio file an audio-imported session was sliced from, kept
// around (session-level, not per-sentence -- every sentence in one import
// shares the same source file) so a later Split/Merge (sentence-panel/
// split.js) can re-slice straight from it instead of compounding error
// through an already-derived clip. null for a plain text-split session, or
// before any session has been opened/imported yet. sourceAudioHash is
// computed once at import time (audio-import.js) and just carried through
// from here on -- see its doc comment in store/sessions.js's updateSession()
// for why it's never re-hashed on every save the way a recording is.
export let sourceAudioBlob = null;
export let sourceAudioHash = null;
export function setSourceAudio(blob, hash) {
  sourceAudioBlob = blob || null;
  sourceAudioHash = hash || null;
}

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
    // The reference clip Speak plays (row.js): the original slice for an
    // imported sentence (permanent), or a synthesized take cached the first
    // time Speak/Export needed one (regenerated if the language changes).
    // Same "pass through whatever we already know" hash story as recordingHash.
    referenceBlob: s.referenceBlob || null,
    referenceHash: s.referenceHash || null,
    referenceSource: s.referenceSource || null,
    // Where in sourceAudioBlob (above) this sentence's reference clip was cut
    // from -- only meaningful when referenceSource === 'import'. Carried
    // through so Split/Merge can keep re-slicing losslessly from the source
    // no matter how many times a sentence gets divided/recombined.
    sourceOffsetMs: s.sourceOffsetMs ?? null,
    sourceDurationMs: s.sourceDurationMs ?? null,
    // Azure's own per-word timestamps within this sentence's own text/audio
    // range (re-based at import time, and re-partitioned/re-based on every
    // later Split/Merge -- see sentence-panel/split.js), and any extra split
    // points the user has manually confirmed via the audio fine-tune UI.
    // Both null when this sentence has no usable word-level timing (a plain
    // text Split, a recording, or an import where Azure returned no
    // per-word data). Drive the clickable split-point triangles drawn above
    // the sentence text (split.js's getSplitPointers()/buildTextEl()).
    words: s.words || null,
    manualPoints: s.manualPoints || null,
  };
}

/** Save the current input text + sentences into the active session, if any. */
export function persistSession() {
  if (currentSessionId == null) return;
  // els.input is only the source of truth for inputText in 'auto' mode --
  // an audio-imported session locks it read-only (applyAudioSessionLock() in
  // sentence-panel/split.js) and never writes into it, so its .value stays
  // whatever it was before the import (usually empty). Persisting that
  // verbatim on every post-import edit (a triangle-click Split, Merge, a
  // hide toggle, ...) was overwriting the session's real inputText -- set
  // once at import time from the sentence texts (handleAudioImport() in
  // sentence-panel/audio-import.js) -- with an empty string, which is what
  // made an audio session's History entry show "(empty)" the moment
  // anything on screen changed after import. Recompute the same way instead,
  // so it stays in sync with whatever the sentences currently say (e.g.
  // after a Split/Merge changes them).
  const inputText = currentSplitMode === 'audio'
    ? sentences.map((s) => s.text).join('\n')
    : els.input.value;
  store.updateSession(currentSessionId, {
    inputText,
    splitMode: currentSplitMode,
    sentences: sentences.map(sentenceToRecord),
    sourceAudioBlob,
    sourceAudioHash,
  }).then(() => scheduleAutoSync())
    .catch((err) => console.warn('Failed to save session locally:', err));
}

export function formatDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
