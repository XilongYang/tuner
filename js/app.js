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
    assessment: s.assessment || null,
  };
}

/** Save the current input text + sentences into the active session, if any. */
function persistSession() {
  if (currentSessionId == null) return;
  store.updateSession(currentSessionId, {
    inputText: els.input.value,
    splitMode: els.splitMode.value,
    sentences: sentences.map(sentenceToRecord),
  }).catch((err) => console.warn('Failed to save session locally:', err));
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
    if (!els.keyPanel.hidden) closeHistorySidebar();
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
      span.appendChild(buildWordTip('Omission · in the reference but not spoken', '', null));
    } else if (w.errorType === 'Insertion') {
      span.dataset.error = 'insertion';
      span.appendChild(buildWordTip('Insertion · spoken but not in the reference', '', null));
    } else {
      const level = accuracyLevel(w.accuracy);
      span.dataset.level = level;
      const errLabel = ERROR_LABELS[w.errorType] || '';
      const head =
        `${w.word} · accuracy ${Math.round(w.accuracy)}${errLabel ? ' · ' + errLabel : ''}`;
      span.appendChild(buildWordTip(head, level, w.phonemes));
    }

    span.addEventListener('click', () => {
      const wasOpen = span.classList.contains('is-open');
      // Only one word panel open at a time.
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

/** Build a word's popover: a heading line + per-phoneme chips. Shown on click (via .word.is-open). */
function buildWordTip(head, headLevel, phonemes) {
  const tip = document.createElement('span');
  tip.className = 'word-tip';

  const h = document.createElement('span');
  h.className = 'tip-head';
  if (headLevel) h.dataset.level = headLevel;
  h.textContent = head;
  tip.appendChild(h);

  if (phonemes && phonemes.length) {
    const pw = document.createElement('span');
    pw.className = 'tip-phonemes';
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
      pw.appendChild(chip);
    }
    tip.appendChild(pw);
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
  els.keyPanel.hidden = true;
  els.toggleKeyPanel.setAttribute('aria-expanded', 'false');
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

/** Load a saved session back onto the screen, replacing whatever is currently shown. */
function openSession(item) {
  for (const s of sentences) s.recorder.dispose();

  els.input.value = item.inputText || '';
  if (item.splitMode) els.splitMode.value = item.splitMode;

  sentences = (item.sentences || []).map((s) => ({
    // Keep the sentence's original id stable across reopens: it's what ties a
    // saved recording to its blob path on Azure (tuner/recordings/<sessionId>/<sentenceId>.wav).
    // Reassigning a fresh one here would orphan the old blob on the next backup.
    id: s.id ?? crypto.randomUUID(),
    text: s.text,
    lang: s.lang,
    hidden: s.hidden,
    recorder: new Recorder(),
    recordingUrl: s.recordingBlob ? URL.createObjectURL(s.recordingBlob) : null,
    recordingBlob: s.recordingBlob || null,
    assessment: s.assessment || null,
  }));

  currentSessionId = item.id;
  render();
  refreshHistoryTreeIfOpen(); // keep the sidebar open; just update the "current" highlight
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
}

function setBlobActionStatus(text, kind) {
  els.blobActionStatus.hidden = !text;
  els.blobActionStatus.textContent = text;
  if (kind) els.blobActionStatus.dataset.kind = kind;
  else delete els.blobActionStatus.dataset.kind;
}

/** Reduce a saved session to the manifest shape (recordings uploaded separately). */
function sessionToManifestEntry(session, uploads) {
  const sentences = (session.sentences || []).map((s) => {
    const hasRecording = !!s.recordingBlob;
    if (hasRecording) uploads.push({ sessionId: session.id, sentenceId: s.id, blob: s.recordingBlob });
    return {
      id: s.id,
      text: s.text,
      lang: s.lang,
      hidden: s.hidden,
      assessment: s.assessment || null,
      hasRecording,
    };
  });
  return {
    id: session.id,
    folderId: session.folderId,
    name: session.name,
    inputText: session.inputText,
    splitMode: session.splitMode,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    sentences,
  };
}

const BLOB_MANIFEST_PATH = 'tuner/manifest.json';
const BLOB_RECORDINGS_PREFIX = 'tuner/recordings/';
const blobRecordingPath = (sessionId, sentenceId) => `${BLOB_RECORDINGS_PREFIX}${sessionId}/${sentenceId}.wav`;

/**
 * Delete any recording blob on Azure that the current backup no longer references
 * (e.g. its session was deleted locally since the last backup). Best-effort: a
 * missing List/Delete permission on the SAS token, or any other failure, is left
 * for the caller to report as a warning rather than fail the whole backup — the
 * manifest + recording uploads before this point already succeeded.
 */
async function cleanupOrphanRecordings(sasUrl, referencedPaths) {
  const allBlobs = await blobStore.listBlobs(sasUrl, BLOB_RECORDINGS_PREFIX);
  const referenced = new Set(referencedPaths);
  const orphans = allBlobs.filter((name) => !referenced.has(name));
  for (let i = 0; i < orphans.length; i++) {
    setBlobActionStatus(`Removing orphaned recording ${i + 1} / ${orphans.length}\u2026`, 'info');
    await blobStore.deleteBlob(sasUrl, orphans[i]);
  }
  return orphans.length;
}

/** Upload everything (folders, sessions, recordings) to Azure, overwriting the existing backup. */
async function backupToAzure() {
  const sasUrl = loadBlobSasUrl();
  if (!sasUrl) { alert('Please save a container SAS URL first.'); return; }

  els.backupNowBtn.disabled = true;
  els.restoreNowBtn.disabled = true;
  try {
    setBlobActionStatus('Reading local data\u2026', 'info');
    const { folders, sessions } = await store.exportAll();

    const uploads = [];
    const manifestSessions = sessions.map((session) => sessionToManifestEntry(session, uploads));
    const manifest = {
      version: 1,
      exportedAt: new Date().toISOString(),
      folders,
      sessions: manifestSessions,
    };

    for (let i = 0; i < uploads.length; i++) {
      const { sessionId, sentenceId, blob } = uploads[i];
      setBlobActionStatus(`Uploading recording ${i + 1} / ${uploads.length}\u2026`, 'info');
      await blobStore.uploadBytes(sasUrl, blobRecordingPath(sessionId, sentenceId), blob, 'audio/wav');
    }

    setBlobActionStatus('Uploading manifest\u2026', 'info');
    await blobStore.uploadJson(sasUrl, BLOB_MANIFEST_PATH, manifest);

    // Best-effort: remove recordings on Azure that no local session references
    // any more (deleted locally since the last backup). Never fails the backup
    // itself — the manifest + recordings above are already safely uploaded.
    let cleanedCount = 0;
    let cleanupWarning = '';
    try {
      const referencedPaths = uploads.map(({ sessionId, sentenceId }) => blobRecordingPath(sessionId, sentenceId));
      cleanedCount = await cleanupOrphanRecordings(sasUrl, referencedPaths);
    } catch (err) {
      cleanupWarning = ` (orphan cleanup skipped: ${err.message})`;
      console.warn('Orphan recording cleanup skipped:', err);
    }

    setBlobActionStatus(
      `Backup complete \u2014 ${sessions.length} session(s), ${uploads.length} recording(s)` +
      (cleanedCount ? `, ${cleanedCount} orphan recording(s) removed` : '') +
      `.${cleanupWarning}`,
      cleanupWarning ? 'error' : 'recording',
    );
  } catch (err) {
    setBlobActionStatus('Backup failed: ' + err.message, 'error');
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
        setBlobActionStatus('No backup found on Azure yet \u2014 run "Backup now" first.', 'error');
        return;
      }
      throw err;
    }

    const manifestSessions = manifest.sessions || [];
    const totalRecordings = manifestSessions.reduce(
      (sum, session) => sum + (session.sentences || []).filter((s) => s.hasRecording).length,
      0,
    );

    let downloaded = 0;
    const sessionsOut = [];
    for (const session of manifestSessions) {
      const sentencesOut = [];
      for (const s of session.sentences || []) {
        let recordingBlob = null;
        if (s.hasRecording) {
          downloaded++;
          setBlobActionStatus(`Downloading recording ${downloaded} / ${totalRecordings}\u2026`, 'info');
          recordingBlob = await blobStore.downloadBytes(sasUrl, blobRecordingPath(session.id, s.id));
        }
        sentencesOut.push({
          id: s.id,
          text: s.text,
          lang: s.lang,
          hidden: s.hidden,
          assessment: s.assessment || null,
          recordingBlob,
        });
      }
      sessionsOut.push({
        id: session.id,
        folderId: session.folderId,
        name: session.name,
        inputText: session.inputText,
        splitMode: session.splitMode,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        sentences: sentencesOut,
      });
    }

    setBlobActionStatus('Writing to local storage\u2026', 'info');
    await store.restoreSnapshot({ folders: manifest.folders || [], sessions: sessionsOut });

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
      `Restore complete \u2014 ${sessionsOut.length} session(s), ${totalRecordings} recording(s).`,
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
  });

  els.clearBlobBtn.addEventListener('click', () => {
    clearBlobSasUrl();
    els.blobSasInput.value = '';
    updateBlobPanel();
  });

  els.backupNowBtn.addEventListener('click', backupToAzure);
  els.restoreNowBtn.addEventListener('click', restoreFromAzure);

  updateBlobPanel();
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
      document.querySelectorAll('.word.is-open').forEach((el) => el.classList.remove('is-open'));
    }
  });

  render();
}

init();
