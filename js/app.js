// Main application logic: wires the modules together and manages the sentence
// list and UI interactions.

import { segment, splitBySlash } from './segment.js';
import { detectLang, LOCALES } from './lang.js';
import { synthesizeAzure, speakWithBrowser } from './tts.js';
import { assessPronunciation } from './pron.js';
import { Recorder } from './recorder.js';
import { makeZip } from './zip.js';
import * as store from './store.js';
import * as blobStore from './azure-blob.js';
import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  hasCredentials,
  loadHideText,
  saveHideText,
  loadHistoryOpen,
  saveHistoryOpen,
  VOICE_OPTIONS,
  getVoice,
  saveVoice,
  loadBlobSasUrl,
  saveBlobSasUrl,
  clearBlobSasUrl,
  hasBlobSasUrl,
} from './config.js';

// ---- Global state ----

/** @type {Array<{ id: string, text: string, lang: 'ja'|'en', hidden: boolean, recorder: Recorder, recordingUrl: string|null, recordingBlob: Blob|null, assessment: object|null }>} */
let sentences = [];

// Global "hide text" switch; the default value for each per-sentence toggle.
let globalHideText = false;

// Tracks an in-progress per-word "Retest" recording (opened from a word's score
// popover). Ephemeral only -- never touches `sentence.assessment` or persistSession() --
// so switching words, closing the popover, or a fresh Split can safely cancel it.
let activeWordRetest = null;
function stopActiveWordRetest() {
  if (activeWordRetest) {
    activeWordRetest.stop();
    activeWordRetest = null;
  }
}

// ---- Sync "busy" tracking ----
// A sentence is busy while something not yet reflected in IndexedDB is in
// flight for it (a network request) or while it's mid-recording. Automatic
// sync (see scheduleAutoSync() below) waits out a busy SESSION entirely
// before running at all; a sync that does run (including a manual click)
// still leaves an individual busy SENTENCE's live UI state untouched when
// applying incoming changes (see applyIncomingSessionUpdate()) rather than
// yanking the row out from under an in-progress recording or Retest.
const busySentenceIds = new Set();
function markSentenceBusy(id) { busySentenceIds.add(id); }
function unmarkSentenceBusy(id) { busySentenceIds.delete(id); }
function isSentenceBusy(id) {
  if (busySentenceIds.has(id)) return true;
  const live = sentences.find((s) => s.id === id);
  return !!(live && live.recorder && live.recorder.isRecording);
}
function isSessionBusy() {
  if (busySentenceIds.size > 0) return true;
  return sentences.some((s) => s.recorder && s.recorder.isRecording);
}

// ---- Local persistence (IndexedDB) ----
// The id of the session currently on screen (one per Split click); null when
// nothing has been split yet, or when saving isn't available in this browser.
let currentSessionId = null;

/** Reduce a sentence to the fields worth persisting (drop the live Recorder). */
function sentenceToRecord(s) {
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
function persistSession() {
  if (currentSessionId == null) return;
  store.updateSession(currentSessionId, {
    inputText: els.input.value,
    splitMode: els.splitMode.value,
    sentences: sentences.map(sentenceToRecord),
  }).then(() => scheduleAutoSync())
    .catch((err) => console.warn('Failed to save session locally:', err));
}

function formatDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Reusable audio element for TTS playback
const ttsAudio = new Audio();

// Global playback controller: only one clip plays at a time. Marks the triggering
// button active while it plays, and enforces mutual exclusion across Speak / Playback.
const player = {
  audio: null,
  button: null,
  _onEnded: null,
  /** Stop the current playback (if any) and clear its active button. */
  stop() {
    if (this.audio) {
      if (this._onEnded) this.audio.removeEventListener('ended', this._onEnded);
      this.audio.pause();
      this.audio = null;
      this._onEnded = null;
    }
    if (this.button) {
      this.button.classList.remove('is-playing');
      this.button = null;
    }
    // Also stop the browser speechSynthesis fallback, if any is speaking.
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  },
  /** Start playing `audio`, marking `button` active; stops whatever was playing first. */
  start(audio, button) {
    this.stop();
    this.audio = audio;
    this.button = button;
    if (button) button.classList.add('is-playing');
    this._onEnded = () => this.stop();
    audio.addEventListener('ended', this._onEnded);
    return audio.play();
  },
  /** Whether `button` is the one currently playing. */
  isActive(button) {
    return this.button === button && !!this.audio;
  },
};

// In-memory cache of synthesized TTS audio, keyed by a hash of voice + text, so
// repeating Speak on the same text and voice doesn't re-request Azure. Values are
// { blob, url }; kept for the session (cleared on reload).
const ttsCache = new Map();

/** Build a cache key: SHA-256 hex of "voice + text" (falls back to the raw string). */
async function ttsCacheKey(voice, text) {
  const raw = voice + '\n' + text;
  if (window.crypto && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return raw;
}

/**
 * Get the reference TTS audio for text/locale, from cache or by synthesizing.
 * Requires Azure credentials. `onMiss` (optional) runs just before a network fetch.
 * @returns {Promise<{ blob: Blob, url: string }>}
 */
async function getTtsEntry(text, locale, onMiss) {
  const key = await ttsCacheKey(getVoice(locale), text);
  let entry = ttsCache.get(key);
  if (!entry) {
    if (onMiss) onMiss();
    const blob = await synthesizeAzure(text, locale);
    entry = { blob, url: URL.createObjectURL(blob) };
    ttsCache.set(key, entry);
  }
  return entry;
}

// ---- DOM references ----
const $ = (sel) => document.querySelector(sel);

const els = {
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

// ---- Credentials panel ----

// Two mutually exclusive states: has key → one-line status + Clear;
// no key → input fields + Save.
function updateKeyPanel() {
  const creds = loadCredentials();
  const has = !!creds;
  els.keyEntry.hidden = has;
  els.keySaved.hidden = !has;
  if (has) {
    els.keyStatus.textContent = `Key saved · Region = ${creds.region}`;
  }
}

function initKeyPanel() {
  els.saveKeyBtn.addEventListener('click', () => {
    const key = els.keyInput.value.trim();
    const region = els.regionInput.value.trim();
    if (!key || !region) {
      alert('Please enter both Key and Region');
      return;
    }
    saveCredentials(key, region);
    els.keyInput.value = '';
    updateKeyPanel();
  });

  els.clearKeyBtn.addEventListener('click', () => {
    clearCredentials();
    els.keyInput.value = '';
    els.regionInput.value = '';
    updateKeyPanel();
  });

  els.toggleKeyPanel.addEventListener('click', () => {
    els.keyPanel.hidden = !els.keyPanel.hidden;
    els.toggleKeyPanel.setAttribute('aria-expanded', String(!els.keyPanel.hidden));
  });

  initVoiceSelectors();
  updateKeyPanel();
}

/** Populate and wire the voice selectors; choices are written to localStorage. */
function initVoiceSelectors() {
  const wire = (selectEl, locale) => {
    for (const opt of VOICE_OPTIONS[locale]) {
      const o = document.createElement('option');
      o.value = opt.id;
      o.textContent = opt.label;
      selectEl.appendChild(o);
    }
    selectEl.value = getVoice(locale);
    selectEl.addEventListener('change', () => saveVoice(locale, selectEl.value));
  };
  wire(els.voiceJa, 'ja-JP');
  wire(els.voiceEn, 'en-US');
}

// ---- Sentence list ----

async function handleSplit() {
  const parts = els.splitMode.value === 'manual'
    ? splitBySlash(els.input.value)
    : segment(els.input.value);
  stopActiveWordRetest();
  // Release resources from the previous recordings
  for (const s of sentences) s.recorder.dispose();

  sentences = parts.map((text) => ({
    id: crypto.randomUUID(),
    text,
    lang: detectLang(text),
    hidden: globalHideText, // defaults to the global switch
    recorder: new Recorder(),
    recordingUrl: null,
    recordingBlob: null,
    recordingHash: null,
    assessment: null,
  }));

  render();

  // Each Split starts a new saved session (local only, via IndexedDB).
  currentSessionId = null;
  if (sentences.length && store.isSupported()) {
    try {
      currentSessionId = await store.createSession({
        inputText: els.input.value,
        splitMode: els.splitMode.value,
        sentences: sentences.map(sentenceToRecord),
      });
      refreshHistoryTreeIfOpen();
      scheduleAutoSync();
    } catch (err) {
      console.warn('Failed to save session locally:', err);
    }
  }
}

function render() {
  els.list.innerHTML = '';
  els.count.textContent = sentences.length
    ? `${sentences.length} ${sentences.length > 1 ? 'sentences' : 'sentence'}`
    : '';

  if (sentences.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-hint';
    empty.textContent = 'Paste text and click Split; sentences will appear here, one per line.';
    els.list.appendChild(empty);
    return;
  }

  sentences.forEach((sentence, index) => {
    els.list.appendChild(renderRow(sentence, index));
  });
}

/** Build the sentence text element; wrap the whole sentence in an inline span so
 *  that when hidden it renders as a continuous black bar per line.
 *  The hidden state lives on the row (.sentence-row.is-hidden), so it also drives
 *  the per-word blocks in the score result. */
function buildTextEl(sentence) {
  const el = document.createElement('div');
  el.className = 'row-text';
  const inner = document.createElement('span');
  inner.className = 'row-text-inner';
  inner.textContent = sentence.text;
  el.appendChild(inner);
  return el;
}

/** Refresh the label of a sentence's hide toggle button. */
function paintHidden(sentence) {
  if (!sentence._hideBtn) return;
  sentence._hideBtn.textContent = sentence.hidden ? 'Show' : 'Hide';
  sentence._hideBtn.setAttribute('aria-pressed', String(sentence.hidden));
}

/** Set a sentence's hidden state and sync the DOM. */
function applyHidden(sentence, value) {
  sentence.hidden = value;
  if (sentence._row) sentence._row.classList.toggle('is-hidden', value);
  paintHidden(sentence);
}

function renderRow(sentence, index) {
  const row = document.createElement('div');
  row.className = 'sentence-row';
  if (sentence.hidden) row.classList.add('is-hidden');
  sentence._row = row;

  // Index
  const num = document.createElement('div');
  num.className = 'row-index';
  num.textContent = String(index + 1).padStart(2, '0');
  row.appendChild(num);

  // Body
  const body = document.createElement('div');
  body.className = 'row-body';

  const textEl = buildTextEl(sentence);
  body.appendChild(textEl);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'row-actions';

  // Language toggle
  const langToggle = document.createElement('button');
  langToggle.className = 'lang-toggle';
  langToggle.type = 'button';
  const paintLang = () => {
    langToggle.textContent = sentence.lang;
    langToggle.title = 'Click to switch language (ja / en)';
  };
  paintLang();
  langToggle.addEventListener('click', () => {
    sentence.lang = sentence.lang === 'ja' ? 'en' : 'ja';
    paintLang();
    persistSession();
  });
  actions.appendChild(langToggle);

  // Per-sentence "hide text" toggle
  const hideBtn = document.createElement('button');
  hideBtn.className = 'hide-toggle';
  hideBtn.type = 'button';
  hideBtn.title = 'Toggle hiding this sentence';
  sentence._hideBtn = hideBtn;
  paintHidden(sentence);
  hideBtn.addEventListener('click', () => {
    applyHidden(sentence, !sentence.hidden);
    persistSession();
  });
  actions.appendChild(hideBtn);

  // Speak
  const playBtn = document.createElement('button');
  playBtn.className = 'btn';
  playBtn.type = 'button';
  playBtn.textContent = 'Speak';
  actions.appendChild(playBtn);

  // Record
  const recordBtn = document.createElement('button');
  recordBtn.className = 'btn';
  recordBtn.type = 'button';
  recordBtn.textContent = 'Record';
  actions.appendChild(recordBtn);

  // Playback
  const playbackBtn = document.createElement('button');
  playbackBtn.className = 'btn';
  playbackBtn.type = 'button';
  playbackBtn.textContent = 'Playback';
  playbackBtn.hidden = !sentence.recordingUrl;
  actions.appendChild(playbackBtn);

  // Score
  const scoreBtn = document.createElement('button');
  scoreBtn.className = 'btn';
  scoreBtn.type = 'button';
  scoreBtn.textContent = 'Score';
  scoreBtn.hidden = !sentence.recordingBlob;
  actions.appendChild(scoreBtn);

  // Export (only once a score exists)
  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn';
  exportBtn.type = 'button';
  exportBtn.textContent = 'Export';
  exportBtn.hidden = !sentence.assessment;
  actions.appendChild(exportBtn);

  body.appendChild(actions);

  // Status / error line
  const status = document.createElement('div');
  status.className = 'row-status';
  status.hidden = true;
  body.appendChild(status);

  // Score result container
  const result = document.createElement('div');
  result.className = 'row-result';
  result.hidden = true;
  body.appendChild(result);

  row.appendChild(body);

  // ---- Row interactions ----
  wireRow({ sentence, row, playBtn, recordBtn, playbackBtn, scoreBtn, exportBtn, status, result });

  // Restore an already-computed score (e.g. when reopening a saved session).
  if (sentence.assessment) {
    renderAssessment(result, sentence.assessment, sentence);
  }

  return row;
}

function setStatus(statusEl, message, kind = 'info') {
  if (!message) {
    statusEl.hidden = true;
    statusEl.textContent = '';
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
}

function wireRow({ sentence, row, playBtn, recordBtn, playbackBtn, scoreBtn, exportBtn, status, result }) {
  // Speak
  playBtn.addEventListener('click', async () => {
    // Toggle: clicking while it's playing stops it.
    if (player.isActive(playBtn)) {
      player.stop();
      setStatus(status, '', 'info');
      return;
    }
    const locale = LOCALES[sentence.lang];
    player.stop(); // stop any other playback first
    playBtn.disabled = true;
    try {
      if (hasCredentials()) {
        // Reuse cached audio for the same voice + text; synthesize only on a miss.
        const entry = await getTtsEntry(sentence.text, locale,
          () => setStatus(status, 'Synthesizing speech…', 'info'));
        ttsAudio.src = entry.url;
        await player.start(ttsAudio, playBtn);
        setStatus(status, '', 'info');
      } else {
        await speakWithBrowser(sentence.text, locale);
        setStatus(status, "(Using the browser's built-in voice — add an Azure key for more natural speech.)", 'info');
      }
    } catch (err) {
      setStatus(status, 'Speak failed: ' + err.message, 'error');
    } finally {
      playBtn.disabled = false;
    }
  });

  // Record (toggle start/stop)
  recordBtn.addEventListener('click', async () => {
    if (sentence.recorder.isRecording) {
      recordBtn.disabled = true;
      try {
        const { url, blob } = await sentence.recorder.stop();
        sentence.recordingUrl = url;
        sentence.recordingBlob = blob;
        recordBtn.textContent = 'Record';
        row.classList.remove('is-recording');
        playbackBtn.hidden = false;
        scoreBtn.hidden = false;
        setStatus(status, 'Recording done. Click Playback to listen, or Score to assess pronunciation.', 'info');
        persistSession();
      } catch (err) {
        setStatus(status, 'Failed to stop recording: ' + err.message, 'error');
      } finally {
        recordBtn.disabled = false;
      }
    } else {
      player.stop(); // stop any playback before recording
      setStatus(status, '', 'info');
      try {
        await sentence.recorder.start();
        recordBtn.textContent = 'Stop';
        row.classList.add('is-recording');
        setStatus(status, '● Recording… click Stop to finish.', 'recording');
      } catch (err) {
        setStatus(status, 'Cannot record: ' + err.message, 'error');
      }
    }
  });

  // Playback
  playbackBtn.addEventListener('click', () => {
    // Toggle: clicking while it's playing stops it.
    if (player.isActive(playbackBtn)) {
      player.stop();
      return;
    }
    if (!sentence.recordingUrl) return;
    const audio = new Audio(sentence.recordingUrl);
    player.start(audio, playbackBtn).catch((err) => {
      setStatus(status, 'Playback failed: ' + err.message, 'error');
    });
  });

  // Score
  scoreBtn.addEventListener('click', async () => {
    if (!sentence.recordingBlob) {
      setStatus(status, 'Please record before scoring.', 'error');
      return;
    }
    scoreBtn.disabled = true;
    result.hidden = true;
    setStatus(status, 'Assessing pronunciation…', 'info');
    markSentenceBusy(sentence.id);
    try {
      const locale = LOCALES[sentence.lang];
      const assessment = await assessPronunciation(
        sentence.recordingBlob, sentence.text, locale);
      sentence.assessment = assessment;
      renderAssessment(result, assessment, sentence);
      exportBtn.hidden = false; // export becomes available once scored
      setStatus(status, '', 'info');
      persistSession();
    } catch (err) {
      setStatus(status, 'Scoring failed: ' + err.message, 'error');
    } finally {
      unmarkSentenceBusy(sentence.id);
      scoreBtn.disabled = false;
    }
  });

  // Export: bundle text + reference audio + recording + score into a ZIP.
  exportBtn.addEventListener('click', async () => {
    if (!sentence.assessment) return;
    if (!hasCredentials()) {
      setStatus(status, 'Export needs Azure credentials to fetch the reference audio.', 'error');
      return;
    }
    exportBtn.disabled = true;
    setStatus(status, 'Preparing export…', 'info');
    try {
      const locale = LOCALES[sentence.lang];
      // Fetch (and cache) the reference audio if it isn't cached yet.
      const ref = await getTtsEntry(sentence.text, locale,
        () => setStatus(status, 'Fetching reference audio…', 'info'));

      const enc = (s) => new TextEncoder().encode(s);
      const meta = {
        text: sentence.text,
        lang: sentence.lang,
        voice: getVoice(locale),
        exportedAt: new Date().toISOString(),
        overall: sentence.assessment.overall,
        words: sentence.assessment.words,
      };
      const files = [
        { name: 'text.txt', data: enc(sentence.text) },
        { name: 'reference.mp3', data: new Uint8Array(await ref.blob.arrayBuffer()) },
        { name: 'score.json', data: enc(JSON.stringify(meta, null, 2)) },
      ];
      if (sentence.recordingBlob) {
        files.push({ name: 'recording.wav', data: new Uint8Array(await sentence.recordingBlob.arrayBuffer()) });
      }
      downloadBlob(makeZip(files), `tuner-${slugify(sentence.text)}.zip`);
      setStatus(status, '', 'info');
    } catch (err) {
      setStatus(status, 'Export failed: ' + err.message, 'error');
    } finally {
      exportBtn.disabled = false;
    }
  });
}

/** Make a filename-safe slug from the sentence text. */
function slugify(text) {
  const s = text.trim().slice(0, 24).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return s || 'sentence';
}

/** Trigger a download of a Blob under the given filename. */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Map an accuracy score to a display level. */
function accuracyLevel(score) {
  if (score >= 80) return 'good';
  if (score >= 60) return 'mid';
  return 'bad';
}

const ERROR_LABELS = {
  None: '',
  Mispronunciation: 'mispronounced',
  Omission: 'omission',
  Insertion: 'insertion',
  UnexpectedBreak: 'unexpected break',
  MissingBreak: 'missing break',
  Monotone: 'monotone',
};

/** Render the assessment: overall scores + per-word coloring. */
function renderAssessment(container, a, sentence) {
  container.innerHTML = '';
  container.hidden = false;

  // Overall scores
  const scores = document.createElement('div');
  scores.className = 'score-grid';
  const items = [
    ['Overall', a.overall.pron],
    ['Accuracy', a.overall.accuracy],
    ['Fluency', a.overall.fluency],
    ['Completeness', a.overall.completeness],
  ];
  for (const [label, value] of items) {
    const chip = document.createElement('div');
    chip.className = 'score-chip';
    chip.dataset.level = accuracyLevel(value);
    chip.innerHTML =
      `<span class="score-value">${Math.round(value)}</span>` +
      `<span class="score-label">${label}</span>`;
    scores.appendChild(chip);
  }
  container.appendChild(scores);

  // Per-word: click a word to open its scores panel and hear it read aloud.
  const wordsWrap = document.createElement('div');
  wordsWrap.className = 'words-line';
  for (const w of a.words) {
    const span = document.createElement('span');
    span.className = 'word';
    span.appendChild(document.createTextNode(w.word));

    if (w.errorType === 'Omission') {
      span.dataset.error = 'omission';
    } else if (w.errorType === 'Insertion') {
      span.dataset.error = 'insertion';
    } else {
      span.dataset.level = accuracyLevel(w.accuracy);
    }
    span.appendChild(buildWordTip(w, sentence));

    span.addEventListener('click', () => {
      const wasOpen = span.classList.contains('is-open');
      // Only one word panel open at a time; switching (or closing) cancels any
      // in-progress per-word retest recording for whichever popover was open.
      stopActiveWordRetest();
      wordsWrap.querySelectorAll('.word.is-open').forEach((el) => el.classList.remove('is-open'));
      if (wasOpen) return; // toggle closed
      span.classList.add('is-open');
      if (w.word) playWord(w.word, sentence); // play just this word (best-effort)
    });

    wordsWrap.appendChild(span);
  }
  container.appendChild(wordsWrap);

  // Legend
  const legend = buildLegend();
  container.appendChild(legend);
}

/** Play the reference TTS audio of a single word (best-effort; needs credentials). */
async function playWord(text, sentence) {
  if (!hasCredentials()) return;
  try {
    const entry = await getTtsEntry(text, LOCALES[sentence.lang]);
    ttsAudio.src = entry.url;
    await player.start(ttsAudio, null);
  } catch { /* ignore per-word playback errors */ }
}

/**
 * Build a word's popover: a heading line + per-phoneme chips, plus a "Retest"
 * control that records just this one word, re-scores it against Azure, and
 * swaps the heading/phonemes to show the new result in its place.
 *
 * The retest result lives only in this closure (`retestWord` below) -- it never
 * touches `w` or `sentence.assessment` and is never passed to persistSession(),
 * so it is purely a this-session, this-popover scratchpad: closing the popover,
 * reopening the word, or reloading the page loses it.
 */
function buildWordTip(w, sentence) {
  const tip = document.createElement('span');
  tip.className = 'word-tip';
  // Clicks inside the popover (the Retest button, in particular) must not bubble
  // up to the word span's own click handler, which would immediately toggle the
  // popover closed again.
  tip.addEventListener('click', (e) => e.stopPropagation());

  const head = document.createElement('span');
  head.className = 'tip-head';
  const phonemesWrap = document.createElement('span');
  phonemesWrap.className = 'tip-phonemes';
  tip.appendChild(head);
  tip.appendChild(phonemesWrap);

  let retestWord = null; // set once a retest scores successfully; overrides `w` for display

  /** (Re)render the heading + phoneme chips from either the original score or a completed retest. */
  function renderScore() {
    const data = retestWord || w;
    const prefix = retestWord ? 'Retest: ' : '';
    phonemesWrap.innerHTML = '';
    head.removeAttribute('data-level');

    if (data.errorType === 'Omission') {
      head.textContent = `${prefix}${w.word} · omission · in the reference but not spoken`;
      phonemesWrap.hidden = true;
      return;
    }
    if (data.errorType === 'Insertion') {
      head.textContent = `${prefix}${w.word} · insertion · spoken but not in the reference`;
      phonemesWrap.hidden = true;
      return;
    }

    const level = accuracyLevel(data.accuracy);
    const errLabel = ERROR_LABELS[data.errorType] || '';
    head.dataset.level = level;
    head.textContent =
      `${prefix}${w.word} · accuracy ${Math.round(data.accuracy)}${errLabel ? ' · ' + errLabel : ''}`;

    const phonemes = data.phonemes || [];
    phonemesWrap.hidden = !phonemes.length;
    for (const p of phonemes) {
      const chip = document.createElement('span');
      chip.className = 'ph';
      chip.dataset.level = accuracyLevel(p.accuracy);
      const name = document.createElement('b');
      name.textContent = p.phoneme;
      const score = document.createElement('i');
      score.textContent = Math.round(p.accuracy);
      chip.appendChild(name);
      chip.appendChild(score);
      phonemesWrap.appendChild(chip);
    }
  }
  renderScore();

  // ---- Retest: re-record and re-score just this word (ephemeral, see above) ----
  if (w.word) {
    const retestWrap = document.createElement('span');
    retestWrap.className = 'tip-retest';

    const retestBtn = document.createElement('button');
    retestBtn.className = 'tip-retest-btn';
    retestBtn.type = 'button';
    retestBtn.textContent = '🎙 Retest';

    // Hear the last retest take back; only shown once one exists. Its own object
    // URL (not the Recorder's, which gets revoked on dispose() below) so it stays
    // playable after the mic is released -- revoked when superseded or replaced.
    const playBtn = document.createElement('button');
    playBtn.className = 'tip-retest-play-btn';
    playBtn.type = 'button';
    playBtn.textContent = '▶';
    playBtn.title = 'Play your last retest take';
    playBtn.hidden = true;
    let retestUrl = null;

    const retestStatus = document.createElement('span');
    retestStatus.className = 'tip-retest-status';
    retestStatus.hidden = true;

    function setRetestStatus(message, kind = 'info') {
      if (!message) {
        retestStatus.hidden = true;
        retestStatus.textContent = '';
        return;
      }
      retestStatus.hidden = false;
      retestStatus.textContent = message;
      retestStatus.dataset.kind = kind;
    }

    let recorder = null;

    retestBtn.addEventListener('click', async () => {
      if (recorder && recorder.isRecording) {
        // Stop -> score just this word.
        retestBtn.disabled = true;
        try {
          const { blob } = await recorder.stop();
          recorder.dispose();
          recorder = null;
          activeWordRetest = null;
          retestBtn.textContent = '🎙 Retest';
          retestBtn.classList.remove('is-recording');

          if (retestUrl) URL.revokeObjectURL(retestUrl);
          retestUrl = URL.createObjectURL(blob);
          playBtn.hidden = false;

          setRetestStatus('Assessing…', 'info');
          const locale = LOCALES[sentence.lang];
          const assessment = await assessPronunciation(blob, w.word, locale);
          retestWord = (assessment.words && assessment.words[0]) ||
            { accuracy: 0, errorType: 'None', phonemes: [] };
          renderScore();
          setRetestStatus('', 'info');
        } catch (err) {
          setRetestStatus('Retest failed: ' + err.message, 'error');
        } finally {
          unmarkSentenceBusy(sentence.id); // marked busy for the whole recording+scoring span, below
          retestBtn.disabled = false;
        }
        return;
      }

      // Start recording.
      if (!hasCredentials()) {
        setRetestStatus('Retest needs Azure credentials (see Azure settings).', 'error');
        return;
      }
      stopActiveWordRetest(); // only one word-retest recording at a time
      player.stop(); // stop any playback (reference audio or a previous take) before recording
      playBtn.hidden = true;
      setRetestStatus('', 'info');
      try {
        recorder = new Recorder();
        await recorder.start();
        retestBtn.textContent = '⏹ Stop';
        retestBtn.classList.add('is-recording');
        setRetestStatus('● Recording…', 'recording');
        // Busy from here until the stop-branch's finally above -- covers both
        // the recording itself and the scoring request right after Stop, so
        // an automatic sync never lands mid-Retest and a manual sync never
        // overwrites this sentence's row while a Retest take is in flight.
        markSentenceBusy(sentence.id);
        activeWordRetest = {
          stop() {
            if (recorder) { recorder.dispose(); recorder = null; }
            retestBtn.textContent = '🎙 Retest';
            retestBtn.classList.remove('is-recording');
            setRetestStatus('', 'info');
            unmarkSentenceBusy(sentence.id);
          },
        };
      } catch (err) {
        setRetestStatus('Cannot record: ' + err.message, 'error');
        recorder = null;
      }
    });

    // Playback: toggle, like the row-level Playback button (stops itself on a second click).
    playBtn.addEventListener('click', () => {
      if (player.isActive(playBtn)) {
        player.stop();
        return;
      }
      if (!retestUrl) return;
      const audio = new Audio(retestUrl);
      player.start(audio, playBtn).catch((err) => {
        setRetestStatus('Playback failed: ' + err.message, 'error');
      });
    });

    retestWrap.appendChild(retestBtn);
    retestWrap.appendChild(playBtn);
    retestWrap.appendChild(retestStatus);
    tip.appendChild(retestWrap);
  }

  return tip;
}

function buildLegend() {
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML =
    '<span class="legend-item"><i data-level="good"></i>Good ≥80</span>' +
    '<span class="legend-item"><i data-level="mid"></i>Fair 60–79</span>' +
    '<span class="legend-item"><i data-level="bad"></i>Poor &lt;60</span>' +
    '<span class="legend-item"><i data-error="omission"></i>Omission</span>' +
    '<span class="legend-item"><i data-error="insertion"></i>Insertion</span>' +
    '<span class="legend-hint">Hover a word for per-phoneme scores</span>';
  return legend;
}

// ---- History sidebar (folder tree: browse / rename / move / reopen / delete) ----

let historyPanelOpen = false;
let expandedFolders = new Set();
let openMenuEl = null;

/** Re-render the tree if the sidebar is currently open (e.g. after a new session is created). */
function refreshHistoryTreeIfOpen() {
  if (historyPanelOpen) renderHistoryTree();
}

function openHistorySidebar() {
  historyPanelOpen = true;
  els.historySidebar.classList.add('is-open');
  els.toggleHistoryPanel.setAttribute('aria-expanded', 'true');
  saveHistoryOpen(true);
  renderHistoryTree();
}

function closeHistorySidebar() {
  historyPanelOpen = false;
  els.historySidebar.classList.remove('is-open');
  els.toggleHistoryPanel.setAttribute('aria-expanded', 'false');
  saveHistoryOpen(false);
  closeCtxMenu();
}

function emptyMsg(text) {
  const p = document.createElement('p');
  p.className = 'history-empty';
  p.textContent = text;
  return p;
}

async function renderHistoryTree() {
  els.historyTree.innerHTML = '';

  if (!store.isSupported()) {
    els.historyTree.appendChild(emptyMsg("This browser doesn't support local history (IndexedDB unavailable)."));
    return;
  }

  let folders, sessions;
  try {
    [folders, sessions] = await Promise.all([store.listFolders(), store.listSessions()]);
  } catch (err) {
    els.historyTree.appendChild(emptyMsg('Failed to load history: ' + err.message));
    return;
  }

  if (!folders.length && !sessions.length) {
    els.historyTree.appendChild(emptyMsg('No saved sessions yet — click Split to start one.'));
    return;
  }

  // A standing drop target for dragging something back out to the top level.
  if (folders.length) {
    const rootDrop = document.createElement('div');
    rootDrop.className = 'tree-row tree-root-drop';
    rootDrop.textContent = 'Root — drop here to remove from folder';
    makeDropTarget(rootDrop, null);
    els.historyTree.appendChild(rootDrop);
  }

  els.historyTree.appendChild(renderTreeLevel(null, folders, sessions));
}

// ---- Drag and drop (an alternative to the "Move to…" menu item) ----

function readDragPayload(e) {
  try {
    const raw = e.dataTransfer.getData('text/plain');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Make `row` draggable, carrying `{ kind: 'folder'|'session', id }` as its drag payload. */
function makeDraggable(row, kind, id) {
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify({ kind, id }));
    row.classList.add('is-dragging');
    // Reveal the root drop zone only while a drag is actually in progress.
    els.historyTree.classList.add('is-dragging-active');
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('is-dragging');
    els.historyTree.classList.remove('is-dragging-active');
    document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  });
}

/** Make `row` a drop target that files the dragged folder/session into `targetFolderId` (null = root). */
function makeDropTarget(row, targetFolderId) {
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add('drag-over');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    row.classList.remove('drag-over');
    const payload = readDragPayload(e);
    if (!payload) return;
    try {
      if (payload.kind === 'folder') {
        if (payload.id === targetFolderId) return; // dropped on itself
        const folders = await store.listFolders();
        const descendants = collectDescendantFolderIds(payload.id, folders);
        if (targetFolderId != null && descendants.includes(targetFolderId)) return; // would create a cycle
        await store.moveFolder(payload.id, targetFolderId);
      } else if (payload.kind === 'session') {
        await store.moveSessionToFolder(payload.id, targetFolderId);
      } else {
        return;
      }
      if (targetFolderId != null) expandedFolders.add(targetFolderId);
      await renderHistoryTree();
      scheduleAutoSync();
    } catch (err) {
      alert('Failed to move: ' + err.message);
    }
  });
}

/** Build the DOM for one level of the tree (folders, then sessions, both at `parentId`). */
function renderTreeLevel(parentId, folders, sessions) {
  const frag = document.createDocumentFragment();
  const childFolders = folders
    .filter((f) => (f.parentId ?? null) === parentId)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const childSessions = sessions
    .filter((s) => (s.folderId ?? null) === parentId)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  for (const folder of childFolders) frag.appendChild(renderFolderNode(folder, folders, sessions));
  for (const session of childSessions) frag.appendChild(renderSessionNode(session));
  return frag;
}

/** Count all sessions nested anywhere under a folder (for the count badge). */
function countSessionsUnder(folderId, allFolders, allSessions) {
  let count = allSessions.filter((s) => (s.folderId ?? null) === folderId).length;
  for (const f of allFolders.filter((f) => (f.parentId ?? null) === folderId)) {
    count += countSessionsUnder(f.id, allFolders, allSessions);
  }
  return count;
}

function collectDescendantFolderIds(folderId, allFolders) {
  const ids = [];
  for (const f of allFolders.filter((f) => (f.parentId ?? null) === folderId)) {
    ids.push(f.id);
    ids.push(...collectDescendantFolderIds(f.id, allFolders));
  }
  return ids;
}

/** Flat, single-color folder icon (inherits color via currentColor) — used to set folder rows apart from session rows. */
const FOLDER_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3 7a2 2 0 0 1 2-2h4.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>' +
  '</svg>';

function renderFolderNode(folder, allFolders, allSessions) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-row';
  row.dataset.type = 'folder';

  const hasChildren =
    allFolders.some((f) => (f.parentId ?? null) === folder.id) ||
    allSessions.some((s) => (s.folderId ?? null) === folder.id);
  const isExpanded = expandedFolders.has(folder.id);

  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle' + (hasChildren ? '' : ' is-leaf');
  toggle.textContent = hasChildren ? (isExpanded ? '▾' : '▸') : '';
  row.appendChild(toggle);

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.innerHTML = FOLDER_ICON_SVG;
  row.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'tree-label tree-label-folder';
  label.textContent = folder.name || 'Untitled folder';
  row.appendChild(label);

  const total = countSessionsUnder(folder.id, allFolders, allSessions);
  const meta = document.createElement('span');
  meta.className = 'tree-meta';
  meta.textContent = total ? String(total) : '';
  row.appendChild(meta);

  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'tree-menu-btn';
  menuBtn.textContent = '⋯';
  menuBtn.title = 'Folder actions';
  menuBtn.draggable = false;
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openFolderMenu(menuBtn, folder);
  });
  row.appendChild(menuBtn);

  if (hasChildren) {
    row.addEventListener('click', () => {
      if (expandedFolders.has(folder.id)) expandedFolders.delete(folder.id);
      else expandedFolders.add(folder.id);
      renderHistoryTree();
    });
  }

  makeDraggable(row, 'folder', folder.id);
  makeDropTarget(row, folder.id);

  wrap.appendChild(row);

  if (isExpanded && hasChildren) {
    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'tree-children';
    childrenWrap.appendChild(renderTreeLevel(folder.id, allFolders, allSessions));
    wrap.appendChild(childrenWrap);
  }

  return wrap;
}

function renderSessionNode(session) {
  const row = document.createElement('div');
  row.className = 'tree-row tree-row-session';
  row.dataset.type = 'session';
  if (session.id === currentSessionId) row.classList.add('is-current');

  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle is-leaf';
  row.appendChild(toggle);

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = sessionDisplayName(session);
  label.title = formatDate(session.updatedAt || session.createdAt);
  row.appendChild(label);

  const n = (session.sentences || []).length;
  const scored = (session.sentences || []).filter((s) => s.assessment).length;
  const meta = document.createElement('span');
  meta.className = 'tree-meta';
  meta.textContent = scored ? `${scored}/${n}` : String(n);
  row.appendChild(meta);

  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'tree-menu-btn';
  menuBtn.textContent = '⋯';
  menuBtn.title = 'Session actions';
  menuBtn.draggable = false;
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openSessionMenu(menuBtn, session);
  });
  row.appendChild(menuBtn);

  row.addEventListener('click', () => openSession(session));

  makeDraggable(row, 'session', session.id);

  return row;
}

/** A session's display name: its custom name if renamed, else a preview of the practice text. */
function sessionDisplayName(session) {
  if (session.name) return session.name;
  return session.inputText ? session.inputText.slice(0, 40) : '(empty)';
}

// ---- Popup context menu (folder / session actions) ----

function onCtxMenuKeydown(e) {
  if (e.key === 'Escape') closeCtxMenu();
}

function closeCtxMenu() {
  if (!openMenuEl) return;
  openMenuEl.remove();
  openMenuEl = null;
  document.removeEventListener('click', closeCtxMenu, true);
  document.removeEventListener('keydown', onCtxMenuKeydown, true);
}

/** Open a small popup menu anchored under `anchorEl`. `items`: [{label, danger?, onClick}] or 'separator'. */
function openCtxMenu(anchorEl, items) {
  closeCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const item of items) {
    if (item === 'separator') {
      menu.appendChild(document.createElement('hr'));
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.label;
    if (item.danger) btn.classList.add('danger');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeCtxMenu();
      item.onClick();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);

  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = rect.right - menuRect.width;
  let top = rect.bottom + 4;
  if (left < 8) left = 8;
  if (top + menuRect.height > window.innerHeight - 8) top = rect.top - menuRect.height - 4;
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  openMenuEl = menu;
  // Defer listener registration one tick so the click that opened the menu doesn't also close it.
  setTimeout(() => {
    document.addEventListener('click', closeCtxMenu, true);
    document.addEventListener('keydown', onCtxMenuKeydown, true);
  }, 0);
}

function openFolderMenu(anchorEl, folder) {
  openCtxMenu(anchorEl, [
    { label: 'New subfolder', onClick: () => promptCreateFolder(folder.id) },
    { label: 'Rename', onClick: () => startRenameFolder(folder) },
    { label: 'Move to…', onClick: () => openMovePicker({ kind: 'folder', item: folder }) },
    'separator',
    { label: 'Delete folder', danger: true, onClick: () => confirmDeleteFolder(folder) },
  ]);
}

function openSessionMenu(anchorEl, session) {
  openCtxMenu(anchorEl, [
    { label: 'Open', onClick: () => openSession(session) },
    { label: 'Rename', onClick: () => startRenameSession(session) },
    { label: 'Move to…', onClick: () => openMovePicker({ kind: 'session', item: session }) },
    'separator',
    { label: 'Delete', danger: true, onClick: () => confirmDeleteSession(session) },
  ]);
}

// ---- Folder / session actions ----

async function promptCreateFolder(parentId) {
  const name = prompt('Folder name:', '');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    await store.createFolder({ name: trimmed, parentId: parentId ?? null });
    if (parentId != null) expandedFolders.add(parentId);
    await renderHistoryTree();
    scheduleAutoSync();
  } catch (err) {
    alert('Failed to create folder: ' + err.message);
  }
}

async function startRenameFolder(folder) {
  const name = prompt('Rename folder:', folder.name || '');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === folder.name) return;
  try {
    await store.renameFolder(folder.id, trimmed);
    await renderHistoryTree();
    scheduleAutoSync();
  } catch (err) {
    alert('Failed to rename folder: ' + err.message);
  }
}

async function startRenameSession(session) {
  const name = prompt('Rename session:', session.name || sessionDisplayName(session));
  if (name === null) return;
  try {
    await store.renameSession(session.id, name.trim());
    await renderHistoryTree();
    scheduleAutoSync();
  } catch (err) {
    alert('Failed to rename session: ' + err.message);
  }
}

async function confirmDeleteFolder(folder) {
  if (!confirm(`Delete folder "${folder.name}"? Sessions and subfolders inside it will move up one level, not be deleted.`)) return;
  try {
    await store.deleteFolder(folder.id);
    expandedFolders.delete(folder.id);
    await renderHistoryTree();
    scheduleAutoSync();
  } catch (err) {
    alert('Failed to delete folder: ' + err.message);
  }
}

async function confirmDeleteSession(session) {
  if (!confirm('Delete this saved session? This cannot be undone.')) return;
  try {
    await store.deleteSession(session.id);
    if (session.id === currentSessionId) currentSessionId = null;
    await renderHistoryTree();
    scheduleAutoSync();
  } catch (err) {
    alert('Failed to delete session: ' + err.message);
  }
}

/** "Move to…" modal: pick a destination folder (or root) from the full folder tree. */
async function openMovePicker({ kind, item }) {
  const [folders, sessions] = await Promise.all([store.listFolders(), store.listSessions()]);

  const excludeIds = new Set();
  if (kind === 'folder') {
    excludeIds.add(item.id);
    collectDescendantFolderIds(item.id, folders).forEach((id) => excludeIds.add(id));
  }

  let selected = kind === 'folder' ? (item.parentId ?? null) : (item.folderId ?? null);

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });

  const card = document.createElement('div');
  card.className = 'modal-card';

  const h = document.createElement('h3');
  h.textContent = kind === 'folder' ? `Move "${item.name}" to…` : `Move "${sessionDisplayName(item)}" to…`;
  card.appendChild(h);

  const treeWrap = document.createElement('div');
  treeWrap.className = 'modal-tree';

  const rootRow = document.createElement('div');
  rootRow.className = 'modal-tree-row';
  rootRow.textContent = '(Root — no folder)';
  rootRow.addEventListener('click', () => select(null));
  treeWrap.appendChild(rootRow);

  function renderPickerLevel(parentId, depth) {
    const childFolders = folders
      .filter((f) => (f.parentId ?? null) === parentId && !excludeIds.has(f.id))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    for (const f of childFolders) {
      const row = document.createElement('div');
      row.className = 'modal-tree-row';
      row.style.paddingLeft = `${8 + depth * 16}px`;
      row.textContent = f.name || 'Untitled folder';
      row.dataset.folderId = String(f.id);
      row.addEventListener('click', () => select(f.id));
      treeWrap.appendChild(row);
      renderPickerLevel(f.id, depth + 1);
    }
  }
  renderPickerLevel(null, 0);

  function select(id) {
    selected = id;
    rootRow.classList.toggle('is-selected', selected === null);
    treeWrap.querySelectorAll('[data-folder-id]').forEach((el) => {
      el.classList.toggle('is-selected', Number(el.dataset.folderId) === selected);
    });
  }
  select(selected);

  card.appendChild(treeWrap);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => backdrop.remove());
  actions.appendChild(cancelBtn);

  const moveBtn = document.createElement('button');
  moveBtn.className = 'btn primary';
  moveBtn.type = 'button';
  moveBtn.textContent = 'Move';
  moveBtn.addEventListener('click', async () => {
    moveBtn.disabled = true;
    try {
      if (kind === 'folder') await store.moveFolder(item.id, selected);
      else await store.moveSessionToFolder(item.id, selected);
      backdrop.remove();
      await renderHistoryTree();
      scheduleAutoSync();
    } catch (err) {
      moveBtn.disabled = false;
      alert('Failed to move: ' + err.message);
    }
  });
  actions.appendChild(moveBtn);

  card.appendChild(actions);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
}

/**
 * Build a live, on-screen sentence object from a stored/incoming record.
 * Shared by openSession() (full reload) and applyIncomingSessionUpdate()
 * (partial, sync-driven refresh of the session already on screen).
 */
function makeLiveSentence(s) {
  return {
    // Keep the sentence's original id stable: it's what ties a saved
    // recording to its blob path on Azure (tuner/recordings/<sessionId>/<sentenceId>.wav).
    // Reassigning a fresh one here would orphan the old blob on the next sync.
    id: s.id ?? crypto.randomUUID(),
    text: s.text,
    lang: s.lang,
    hidden: s.hidden,
    recorder: new Recorder(),
    recordingUrl: s.recordingBlob ? URL.createObjectURL(s.recordingBlob) : null,
    recordingBlob: s.recordingBlob || null,
    recordingHash: s.recordingHash || null,
    // Sentence-level sync version; not shown in the UI, just carried through
    // so a later persistSession() doesn't lose it and make everything look
    // freshly-changed to the next sync.
    updatedAt: s.updatedAt || null,
    assessment: s.assessment || null,
    assessmentHash: s.assessmentHash || null,
  };
}

/** Load a saved session back onto the screen, replacing whatever is currently shown. */
function openSession(item) {
  for (const s of sentences) s.recorder.dispose();

  els.input.value = item.inputText || '';
  if (item.splitMode) els.splitMode.value = item.splitMode;

  sentences = (item.sentences || []).map(makeLiveSentence);

  currentSessionId = item.id;
  render();
  refreshHistoryTreeIfOpen(); // keep the sidebar open; just update the "current" highlight
}

/**
 * Apply an incoming (post-sync-merge) copy of the session currently on
 * screen, without the disruption of a full openSession() reload: a sentence
 * whose persisted fields didn't actually change keeps its live object
 * (Recorder instance, open word-tip popover, everything) untouched, and a
 * BUSY sentence (mid-recording, or mid a word Retest -- see isSentenceBusy())
 * is left alone for this round even if it did change remotely; it picks up
 * that change on the next sync, once it's free. Session-level metadata is
 * applied the same way, skipping the practice-text box while it's focused.
 */
function applyIncomingSessionUpdate(refreshed) {
  if (document.activeElement !== els.input) {
    const nextInput = refreshed.inputText || '';
    if (els.input.value !== nextInput) els.input.value = nextInput;
  }
  if (refreshed.splitMode && els.splitMode.value !== refreshed.splitMode) {
    els.splitMode.value = refreshed.splitMode;
  }

  const liveById = new Map(sentences.map((s) => [s.id, s]));
  let changed = false;
  const next = (refreshed.sentences || []).map((rs) => {
    const live = liveById.get(rs.id);
    if (!live) { changed = true; return makeLiveSentence(rs); }
    const samePersisted =
      live.text === rs.text &&
      live.lang === rs.lang &&
      live.hidden === rs.hidden &&
      (live.recordingHash || null) === (rs.recordingHash || null) &&
      JSON.stringify(live.assessment || null) === JSON.stringify(rs.assessment || null);
    if (samePersisted) return live;
    if (isSentenceBusy(rs.id)) return live; // leave it alone this round
    changed = true;
    live.recorder.dispose();
    return makeLiveSentence(rs);
  });
  // Sentences are never added to or removed from a session after Split (see
  // handleSplit), so `next` always has the same ids as the live array --
  // nothing to reconcile beyond what the map above already does.

  if (changed) {
    sentences = next;
    render();
  }
  currentSessionId = refreshed.id;
  refreshHistoryTreeIfOpen();
}

function initHistoryPanel() {
  els.toggleHistoryPanel.addEventListener('click', () => {
    if (historyPanelOpen) closeHistorySidebar();
    else openHistorySidebar();
  });
  els.historyCloseBtn.addEventListener('click', closeHistorySidebar);

  els.newFolderBtn.addEventListener('click', () => promptCreateFolder(null));

  els.clearHistoryBtn.addEventListener('click', async () => {
    if (!confirm('Delete all saved practice history and folders from this browser? This cannot be undone.')) return;
    els.clearHistoryBtn.disabled = true;
    try {
      await store.clearAll();
      currentSessionId = null;
      await renderHistoryTree();
    } catch (err) {
      alert('Failed to clear history: ' + err.message);
    } finally {
      els.clearHistoryBtn.disabled = false;
    }
  });
}

// ---- Cloud backup (Azure Blob Storage) ----

// Two mutually exclusive states: has a SAS URL -> one-line status + Clear;
// no SAS URL -> input field + Save. Mirrors updateKeyPanel().
function updateBlobPanel() {
  const url = loadBlobSasUrl();
  const has = !!url;
  els.blobEntry.hidden = has;
  els.blobSaved.hidden = !has;
  if (has) {
    let host = url;
    try { host = new URL(url).hostname; } catch { /* keep raw value if unparsable */ }
    els.blobStatus.textContent = `SAS URL saved \u00b7 ${host}`;
  }
  // The header indicator only exists once cloud sync is configured at all;
  // hidden -> shown here, never the reverse (Clear SAS URL below un-configures
  // it again). A freshly-shown indicator starts in "syncing" state since
  // saving a SAS URL immediately kicks off a sync (see initBlobPanel()).
  els.syncIndicator.hidden = !has;
  if (has) updateSyncIndicator('Starting sync\u2026', 'info');
}

// Timestamp of the last sync that completed successfully (kind 'recording'),
// shown in the "Synced" tooltip. In-memory only -- resets on reload, same as
// manifestEtagCache; the next sync completing fills it back in within seconds.
let lastSyncAt = null;

/**
 * Drives the header's compact sync indicator (dot + one of exactly three
 * words: Synced / Syncing / Sync Failed) from the same (text, kind) pairs
 * setBlobActionStatus() already receives throughout syncWithAzure() and
 * restoreFromAzure() -- no separate state machine, just a different rendering
 * of the same signal. Hover (or focus, for keyboard/touch) reveals `text` in
 * full via the tooltip; for a successful completion, the tooltip also gets a
 * prepended timestamp since the underlying message doesn't carry one.
 */
function updateSyncIndicator(text, kind) {
  const state = kind === 'recording' ? 'synced' : kind === 'error' ? 'failed' : 'syncing';
  els.syncIndicator.dataset.kind = state;
  els.syncIndicatorLabel.textContent = state === 'synced' ? 'Synced' : state === 'failed' ? 'Sync Failed' : 'Syncing';
  if (state === 'synced') {
    lastSyncAt = Date.now();
    const detail = text.replace(/^(Sync|Restore) complete \u2014 /, '');
    els.syncIndicatorTooltip.textContent = `Synced at ${formatDate(lastSyncAt)} \u2014 ${detail}`;
  } else {
    els.syncIndicatorTooltip.textContent = text;
  }
}

function setBlobActionStatus(text, kind) {
  els.blobActionStatus.hidden = !text;
  els.blobActionStatus.textContent = text;
  if (kind) els.blobActionStatus.dataset.kind = kind;
  else delete els.blobActionStatus.dataset.kind;
  // Same underlying signal, rendered differently in the header -- see
  // updateSyncIndicator(). Only meaningful once the indicator is showing at
  // all (i.e. cloud sync is configured), which is exactly when this function
  // is ever called with a non-empty text in the first place.
  if (text) updateSyncIndicator(text, kind);
}


const BLOB_MANIFEST_PATH = 'tuner/manifest.json';

// In-memory cache of the manifest ETag/content we last confirmed matches
// what's on Azure -- lets a heartbeat sync (usually finding nothing changed
// anywhere) skip re-downloading and re-parsing the whole manifest via a
// conditional GET, and skip re-uploading it too when the freshly merged
// result is byte-identical to what's already there. Cleared implicitly on
// page reload (it's just a module-level variable); the first sync after a
// reload pays for one real GET, same as before this existed.
let manifestEtagCache = { etag: null, manifest: null };

const BLOB_RECORDINGS_PREFIX = 'tuner/recordings/';
const blobRecordingPath = (sessionId, sentenceId) => `${BLOB_RECORDINGS_PREFIX}${sessionId}/${sentenceId}.wav`;

// A sentence's assessment (word/phoneme-level scores -- by far the largest
// thing in the old, fully-embedded manifest once anything's been scored) and
// a session's inputText each sync as their own small content-addressed blob,
// exactly like a recording: only a hash lives in the manifest, the actual
// content is fetched separately and only when the merge decides this device
// still needs it (see resolveSentenceContent()/resolveSessionInputText()
// inside syncWithAzure()).
const BLOB_ASSESSMENTS_PREFIX = 'tuner/assessments/';
const blobAssessmentPath = (sessionId, sentenceId) => `${BLOB_ASSESSMENTS_PREFIX}${sessionId}/${sentenceId}.json`;
const BLOB_INPUTTEXT_PREFIX = 'tuner/inputtext/';
const blobInputTextPath = (sessionId) => `${BLOB_INPUTTEXT_PREFIX}${sessionId}.txt`;

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
async function cleanupOrphanBlobs(sasUrl, prefix, referencedPaths) {
  const allBlobs = await blobStore.listBlobs(sasUrl, prefix);
  const referenced = new Set(referencedPaths);
  const orphans = allBlobs.filter((name) => !referenced.has(name));
  for (let i = 0; i < orphans.length; i++) {
    setBlobActionStatus(`Removing orphaned file ${i + 1} / ${orphans.length}\u2026`, 'info');
    await blobStore.deleteBlob(sasUrl, orphans[i]);
  }
  return orphans.length;
}

// ---- Merge helpers (last-write-wins, at sentence granularity) ----
//
// These decide, field by field, whose value survives when the same session
// exists on two devices with independent edits since the last sync. The
// design deliberately tracks THREE separate "changed at" signals rather than
// one, because collapsing them into a single timestamp is exactly what would
// force the granularity back up to the whole session:
//   - each sentence's own `updatedAt` (js/store.js's stampSentenceVersions)
//   - a session's `metaUpdatedAt`, for its own scalar fields (name/folderId/
//     splitMode/inputText), separate from...
//   - a session's general `updatedAt`, bumped on every save (sentence-only
//     edits included) and used only for "recently used" sorting.
// A folder has no sub-structure worth splitting further, so it merges on its
// own single `updatedAt`.

function pickNewer(aTs, bTs) {
  return (bTs || 0) > (aTs || 0) ? 'b' : 'a';
}

/**
 * Per-sentence-id union + LWW merge. Tags each surviving sentence with which
 * side it came from (`__from`, stripped before storage/manifest use) so the
 * sync flow below knows, without re-deriving it, whether it already holds
 * that sentence's winning recording or still needs to fetch/send it.
 *
 * No tombstones: sentences are never added to or removed from a session after
 * Split (js/app.js's handleSplit is the only place the array is rebuilt), so
 * there is no "sentence N was deleted" state this needs to represent. Order
 * follows `local`'s sequence -- both sides descend from the same Split, so
 * they should already agree on it; any id that exists only remotely (e.g.
 * this device has never seen this session before) is appended at the end.
 */
function mergeSentences(local, remote) {
  const remoteById = new Map((remote || []).map((s) => [s.id, s]));
  const seen = new Set();
  const merged = (local || []).map((l) => {
    seen.add(l.id);
    const r = remoteById.get(l.id);
    if (!r) return { ...l, __from: 'local' };
    return pickNewer(l.updatedAt, r.updatedAt) === 'b' ? { ...r, __from: 'remote' } : { ...l, __from: 'local' };
  });
  for (const r of remote || []) {
    if (!seen.has(r.id)) merged.push({ ...r, __from: 'remote' });
  }
  return merged;
}

/**
 * Merge one session. Metadata resolves via `metaUpdatedAt` specifically (not
 * sentence `updatedAt`s, not the general `updatedAt`) so a rename on device A
 * and an unrelated recording on device B, made around the same time, both
 * survive instead of one clobbering the other. `local`/`remote` may each be
 * absent (session known to only one side); `mergeSentences` above handles
 * that directly rather than short-circuiting here, so every sentence still
 * gets tagged with its origin.
 */
function mergeSession(local, remote) {
  const base = local || remote;
  const localMeta = local ? (local.metaUpdatedAt ?? local.updatedAt ?? local.createdAt ?? 0) : -1;
  const remoteMeta = remote ? (remote.metaUpdatedAt ?? remote.updatedAt ?? remote.createdAt ?? 0) : -1;
  const metaFrom = remoteMeta > localMeta ? 'remote' : 'local';
  const metaWinner = metaFrom === 'remote' ? remote : base;
  return {
    id: base.id,
    createdAt: Math.min(local?.createdAt ?? Infinity, remote?.createdAt ?? Infinity),
    updatedAt: Math.max(local?.updatedAt || 0, remote?.updatedAt || 0),
    metaUpdatedAt: Math.max(localMeta < 0 ? 0 : localMeta, remoteMeta < 0 ? 0 : remoteMeta),
    name: metaWinner.name,
    folderId: metaWinner.folderId,
    splitMode: metaWinner.splitMode,
    // inputText itself: only the LOCAL copy ever carries the actual text --
    // a remote manifest entry only has inputTextHash (see the manifest
    // shape in syncWithAzure()). __metaFrom tells the sync loop whether it
    // still needs to fetch/keep the actual text, same idea as `__from` on a
    // sentence for its recording/assessment.
    inputText: metaWinner.inputText ?? null,
    inputTextHash: metaWinner.inputTextHash || null,
    __metaFrom: metaFrom,
    sentences: mergeSentences(local?.sentences, remote?.sentences),
  };
}

/** Folder counterpart: no sub-structure, so a plain LWW on `updatedAt` is enough. */
function mergeFolder(local, remote) {
  if (!local) return { ...remote };
  if (!remote) return { ...local };
  return (remote.updatedAt || 0) > (local.updatedAt || 0) ? { ...remote } : { ...local };
}

/** Union two lists by `id`, merging entries present on both sides via `mergeOne`. */
function mergeById(localList, remoteList, mergeOne) {
  const remoteById = new Map((remoteList || []).map((r) => [r.id, r]));
  const seen = new Set();
  const merged = (localList || []).map((l) => {
    seen.add(l.id);
    return mergeOne(l, remoteById.get(l.id));
  });
  for (const r of remoteList || []) {
    if (!seen.has(r.id)) merged.push(mergeOne(null, r));
  }
  return merged;
}

/**
 * Union two tombstone lists by id ("<kind>:<targetId>", from js/store.js),
 * keeping whichever `deletedAt` is newer -- deletions merge the same way
 * edits do, just with a one-bit payload ("gone").
 */
function mergeTombstones(localList, remoteList) {
  const byId = new Map();
  for (const t of localList || []) byId.set(t.id, t);
  for (const t of remoteList || []) {
    const existing = byId.get(t.id);
    if (!existing || t.deletedAt > existing.deletedAt) byId.set(t.id, t);
  }
  return Array.from(byId.values());
}

/**
 * Whether a merged folder/session should still exist after accounting for
 * tombstones: a delete beats an item's own `updatedAt` unless something
 * touched that item again AFTER the delete (an edit newer than the
 * tombstone "un-deletes" it, same principle as any other LWW field here).
 * This is what makes a deletion actually stick across devices instead of
 * being resurrected by the next pull from whichever side still has it.
 */
function survivesTombstone(kind, item, tombstoneById) {
  const t = tombstoneById.get(`${kind}:${item.id}`);
  if (!t) return true;
  return (item.updatedAt || 0) > t.deletedAt;
}

/**
 * Bidirectional incremental sync: merges local IndexedDB data with whatever's
 * on Azure at sentence granularity (see the merge helpers above), uploads
 * only recordings this device's copy actually won and Azure doesn't already
 * have, downloads only recordings the remote side won that this device
 * doesn't already hold, writes the merged result back locally with a
 * non-destructive upsert (never clobbering a session/folder this device
 * hasn't seen), then uploads the merged manifest and sweeps orphaned
 * recordings using paths computed from that MERGED manifest (so a recording
 * only device B knows about doesn't look orphaned from device A's run).
 *
 * Deleting a session or folder IS tracked (js/store.js records a tombstone
 * on deleteSession()/deleteFolder()) and propagates through sync like any
 * other field: survivesTombstone() above only keeps a deletion beaten when
 * something edited that same item again afterward. Edge case worth knowing:
 * a device that's never directly synced with the device that deleted
 * something only learns about the deletion once it syncs with a THIRD device
 * that already has -- tombstones spread by riding along in the manifest, not
 * by broadcasting, so full convergence can take one extra hop in a
 * multi-device chain.
 */
// ---- Automatic sync scheduling ----
//
// Two triggers feed the same path: a local change (debounced, so a burst of
// edits -- e.g. toggling several sentences' hidden flags in a row -- coalesces
// into one sync instead of one per edit) and a 30s idle heartbeat (so a
// device that made no local changes still notices what other devices did).
// Both funnel into runAutoSync(), which (a) waits out a busy session rather
// than skipping it outright -- see isSessionBusy() -- so a change made while
// recording still eventually syncs once recording stops, and (b) takes a
// Web Locks lock before actually running, so if several tabs of this app are
// open at once, only one of them does the network round-trip and the
// IndexedDB writes at a time; the rest see the lock held and simply skip
// that round (the next trigger picks it up).
const AUTO_SYNC_DEBOUNCE_MS = 3000;
const AUTO_SYNC_HEARTBEAT_MS = 30000;
const AUTO_SYNC_LOCK_NAME = 'tuner-cloud-sync';

let autoSyncDebounceTimer = null;
let autoSyncRunning = false; // this tab only; the Web Locks lock below is what actually coordinates across tabs

/**
 * Run syncWithAzure() under the cross-tab lock -- shared by the manual "Sync
 * now" click and the automatic triggers below, so a manual click can never
 * overlap an automatic run IN THE SAME TAB either (without this, the two
 * paths would call syncWithAzure() independently and could run concurrently,
 * reintroducing exactly the read-then-write races the lock is meant to rule
 * out). `wait: true` means a manual click queues behind an in-progress
 * automatic sync instead of silently skipping -- the user asked for it, so it
 * should happen, just after the one already running finishes.
 */
async function runSyncExclusive({ wait, fn = syncWithAzure }) {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    // No Web Locks support (older browser): same-tab-only guard. Cross-tab
    // races become possible, but this tab still never overlaps itself.
    if (autoSyncRunning) return;
    autoSyncRunning = true;
    try { await fn(); } finally { autoSyncRunning = false; }
    return;
  }
  await navigator.locks.request(AUTO_SYNC_LOCK_NAME, wait ? {} : { ifAvailable: true }, async (lock) => {
    if (!lock) return; // another tab is already syncing -- this round is skipped, not queued
    autoSyncRunning = true;
    try { await fn(); } finally { autoSyncRunning = false; }
  });
}

/** The manual "Sync now" button: always runs, queuing behind any sync already in progress. */
function runSyncNow() {
  return runSyncExclusive({ wait: true });
}

/** Debounce a local change into an automatic sync a few seconds from now. No-op if cloud sync isn't configured. */
function scheduleAutoSync(delayMs = AUTO_SYNC_DEBOUNCE_MS) {
  if (!hasBlobSasUrl()) return;
  clearTimeout(autoSyncDebounceTimer);
  autoSyncDebounceTimer = setTimeout(runAutoSync, delayMs);
}

/**
 * Entry point for both automatic triggers (a debounced local change, and the
 * 30s idle heartbeat). Never shows a blocking alert() or asks for
 * confirmation (those are for the manual "Sync now" click) -- a failure here
 * just leaves the status line saying so and waits for the next trigger.
 */
async function runAutoSync() {
  if (!hasBlobSasUrl()) return;
  if (isSessionBusy()) {
    // Don't drop the change: try again shortly rather than waiting for the
    // next unrelated trigger, which might be a while (e.g. mid-recording a
    // long sentence, or nothing else happens for the rest of the 30s window).
    scheduleAutoSync(AUTO_SYNC_DEBOUNCE_MS);
    return;
  }
  await runSyncExclusive({ wait: false });
}

let autoSyncHeartbeatTimer = null;

/** 30s idle heartbeat: only ticks while the tab is visible, so a backgrounded/pinned tab doesn't keep polling Azure and burning battery/quota. */
function startAutoSyncHeartbeat() {
  if (autoSyncHeartbeatTimer) return;
  autoSyncHeartbeatTimer = setInterval(() => {
    if (document.hidden) return;
    runAutoSync();
  }, AUTO_SYNC_HEARTBEAT_MS);
  document.addEventListener('visibilitychange', () => {
    // Catch up promptly on returning to the tab, instead of waiting out
    // whatever's left of the current 30s tick.
    if (!document.hidden) runAutoSync();
  });
}

async function syncWithAzure() {
  const sasUrl = loadBlobSasUrl();
  if (!sasUrl) { alert('Please save a container SAS URL first.'); return; }

  els.backupNowBtn.disabled = true;
  els.restoreNowBtn.disabled = true;
  try {
    setBlobActionStatus('Reading local data…', 'info');
    const { folders: localFolders, sessions: localSessions, tombstones: localTombstones } = await store.exportAll();

    setBlobActionStatus('Checking remote backup…', 'info');
    let remoteManifest = { folders: [], sessions: [], tombstones: [] };
    try {
      const result = await blobStore.downloadJsonConditional(sasUrl, BLOB_MANIFEST_PATH, manifestEtagCache.etag);
      if (result.notModified) {
        // Azure confirmed nothing changed since our cached copy -- reuse it
        // rather than treating "304, no body" as an empty manifest.
        remoteManifest = manifestEtagCache.manifest;
      } else {
        remoteManifest = result.value;
        manifestEtagCache = { etag: result.etag, manifest: remoteManifest };
      }
    } catch (err) {
      if (!err.notFound) throw err;
      manifestEtagCache = { etag: null, manifest: null };
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
      manifestEtagCache = { etag: manifestEtagCache.etag, manifest };
    } else {
      setBlobActionStatus('Uploading manifest…', 'info');
      const newEtag = await blobStore.uploadJson(sasUrl, BLOB_MANIFEST_PATH, manifest);
      manifestEtagCache = { etag: newEtag, manifest };
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
        sentences = [];
        currentSessionId = null;
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
async function restoreFromAzure() {
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
    sentences = [];
    currentSessionId = null;
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

function initBlobPanel() {
  els.saveBlobBtn.addEventListener('click', () => {
    const url = els.blobSasInput.value.trim();
    if (!url) {
      alert('Please paste a container SAS URL');
      return;
    }
    saveBlobSasUrl(url);
    els.blobSasInput.value = '';
    updateBlobPanel();
    scheduleAutoSync(0); // pick up whatever's already on Azure right away, rather than waiting for the first edit or heartbeat tick
  });

  els.clearBlobBtn.addEventListener('click', () => {
    clearBlobSasUrl();
    els.blobSasInput.value = '';
    updateBlobPanel();
  });

  els.backupNowBtn.addEventListener('click', runSyncNow);
  els.restoreNowBtn.addEventListener('click', () => runSyncExclusive({ wait: true, fn: restoreFromAzure }));

  updateBlobPanel();
  startAutoSyncHeartbeat();
}

// ---- Initialization ----

async function init() {
  initKeyPanel();
  initBlobPanel();

  // One-time housekeeping: give any session left over from before ids were
  // switched to UUIDs a fresh one. Awaited before the history sidebar can
  // possibly render, so it never shows a stale legacy id.
  if (store.isSupported()) {
    try {
      const migrated = await store.migrateSessionIdsToUuid();
      if (migrated) console.info(`Migrated ${migrated} legacy session(s) to UUID ids.`);
    } catch (err) {
      console.warn('Legacy session id migration skipped:', err);
    }
  }

  initHistoryPanel();
  if (loadHistoryOpen()) openHistorySidebar();

  // Global "hide text" switch: load from localStorage, write back on change and
  // cascade to all sentences.
  globalHideText = loadHideText();
  els.globalHideInput.checked = globalHideText;
  els.input.classList.toggle('input-masked', globalHideText);
  els.globalHideInput.addEventListener('change', () => {
    globalHideText = els.globalHideInput.checked;
    saveHideText(globalHideText);
    // Cover the practice textarea with a solid black block in hidden mode.
    els.input.classList.toggle('input-masked', globalHideText);
    for (const s of sentences) applyHidden(s, globalHideText);
    persistSession();
  });

  els.splitBtn.addEventListener('click', handleSplit);
  els.clearInputBtn.addEventListener('click', () => {
    els.input.value = '';
    els.input.focus();
  });

  // Clicking anywhere outside a word closes its open scores panel.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.word')) {
      stopActiveWordRetest();
      document.querySelectorAll('.word.is-open').forEach((el) => el.classList.remove('is-open'));
    }
  });

  render();
}

init();
