// The sentence list: Split, per-sentence rendering, and all the per-row
// interactions (Speak, Record, Playback, Score, Export, the word-level score
// popover with its Retest button).

import { segment, splitBySlash } from './segment.js';
import { detectLang, LOCALES } from './lang.js';
import { speakWithBrowser } from './tts.js';
import { assessPronunciation } from './pron.js';
import { Recorder } from './recorder.js';
import { makeZip } from './zip.js';
import * as store from './store.js';
import { hasCredentials, getVoice } from './config.js';
import {
  els,
  sentences,
  setSentences,
  currentSessionId,
  setCurrentSessionId,
  globalHideText,
  sentenceToRecord,
  persistSession,
  markSentenceBusy,
  unmarkSentenceBusy,
} from './state.js';
import { getTtsEntry, player, ttsAudio } from './tts-player.js';
import { refreshHistoryTreeIfOpen } from './history-panel.js';
import { scheduleAutoSync } from './sync.js';

// Tracks an in-progress per-word "Retest" recording (opened from a word's score
// popover). Ephemeral only -- never touches `sentence.assessment` or persistSession() --
// so switching words, closing the popover, or a fresh Split can safely cancel it.
let activeWordRetest = null;
export function stopActiveWordRetest() {
  if (activeWordRetest) {
    activeWordRetest.stop();
    activeWordRetest = null;
  }
}

// ---- Sentence list ----

export async function handleSplit() {
  const parts = els.splitMode.value === 'manual'
    ? splitBySlash(els.input.value)
    : segment(els.input.value);
  stopActiveWordRetest();
  // Release resources from the previous recordings
  for (const s of sentences) s.recorder.dispose();

  setSentences(parts.map((text) => ({
    id: crypto.randomUUID(),
    text,
    lang: detectLang(text),
    hidden: globalHideText, // defaults to the global switch
    recorder: new Recorder(),
    recordingUrl: null,
    recordingBlob: null,
    recordingHash: null,
    assessment: null,
  })));

  render();

  // Each Split starts a new saved session (local only, via IndexedDB).
  setCurrentSessionId(null);
  if (sentences.length && store.isSupported()) {
    try {
      setCurrentSessionId(await store.createSession({
        inputText: els.input.value,
        splitMode: els.splitMode.value,
        sentences: sentences.map(sentenceToRecord),
      }));
      refreshHistoryTreeIfOpen();
      scheduleAutoSync();
    } catch (err) {
      console.warn('Failed to save session locally:', err);
    }
  }
}

export function render() {
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
export function applyHidden(sentence, value) {
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

