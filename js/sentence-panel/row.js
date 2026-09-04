// Per-sentence row: DOM construction (renderRow) and the row-level button
// wiring (Speak / Record / Playback / Score / Export) in wireRow.

import { LOCALES } from '../lang.js';
import { speakWithBrowser } from '../tts.js';
import { assessPronunciation } from '../pron.js';
import { makeZip } from '../zip.js';
import { hasCredentials, getVoice } from '../config.js';
import { persistSession, markSentenceBusy, unmarkSentenceBusy } from '../state.js';
import { getTtsEntry, ensureTtsWords, player, ttsAudio } from '../tts-player.js';
import {
  buildTextEl, paintHidden, applyHidden, toggleRowSelection,
  refreshRowText, splitAtPointer,
} from './split.js';
import { renderAssessment } from './assessment.js';
import { slugify, downloadBlob } from './export-utils.js';

export function renderRow(sentence, index) {
  const row = document.createElement('div');
  row.className = 'sentence-row';
  if (sentence.hidden) row.classList.add('is-hidden');
  sentence._row = row;

  // Index (+ the checkbox used to select this row for merging -- see
  // toggleRowSelection()/mergeSelectedSentences() in split.js)
  const indexCol = document.createElement('div');
  indexCol.className = 'row-index';

  const selectCb = document.createElement('input');
  selectCb.type = 'checkbox';
  selectCb.className = 'row-select-checkbox';
  selectCb.title = 'Select for merging';
  selectCb.setAttribute('aria-label', `Select sentence ${index + 1} for merging`);
  sentence._selectCheckbox = selectCb;
  selectCb.addEventListener('change', () => toggleRowSelection(sentence));
  indexCol.appendChild(selectCb);

  const num = document.createElement('span');
  num.className = 'row-index-num';
  num.textContent = String(index + 1).padStart(2, '0');
  indexCol.appendChild(num);

  row.appendChild(indexCol);

  // Body
  const body = document.createElement('div');
  body.className = 'row-body';

  const textEl = buildTextEl(sentence);
  sentence._textEl = textEl;
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
    // A synthesized reference was recorded in the OLD language -- it's now
    // wrong and would need resynthesizing; Speak will do that on next click.
    // An imported clip's audio never changes just because the language label
    // did, so that one is left alone.
    if (sentence.referenceSource === 'tts') {
      if (sentence.referenceUrl) URL.revokeObjectURL(sentence.referenceUrl);
      sentence.referenceBlob = null;
      sentence.referenceUrl = null;
      sentence.referenceHash = null;
      sentence.referenceSource = null;
      // Any words[] here (see tts-player.js's ensureTtsWords()) are exact
      // Azure timestamps for the OLD-language clip just discarded above --
      // meaningless once that audio is gone, and about to be silently wrong
      // (drawing "exact Azure word boundary" triangles for audio that no
      // longer exists) if left in place until the next Speak re-synthesizes.
      sentence.words = null;
    }
    // A sentence with no real word/manual pointers picks its synthetic split
    // triangles' granularity from sentence.lang (textSplitPoints() in
    // split.js: every character for Japanese, every word gap otherwise) --
    // redraw so switching languages doesn't leave stale triangles from the
    // old language on screen until something else happens to re-render.
    refreshRowText(sentence);
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

  // Click-to-split: every splittable position already carries its own
  // clickable triangle (buildTextEl() in split.js, off getSplitPointers()
  // there -- a real Azure word boundary, a manually-confirmed Merge seam, or,
  // for a sentence with neither, textSplitPoints()'s synthetic fallback --
  // which always has something to offer, so there's a triangle at literally
  // every position). Clicking one splits immediately; there's no separate
  // click-anywhere-in-the-text marker/hint step to find one first.
  body.addEventListener('click', (e) => {
    const tri = e.target.closest('.split-pointer');
    if (!tri) return;
    const charIndex = Number(tri.dataset.charIndex);
    const ms = Number(tri.dataset.ms);
    tri.disabled = true;
    splitAtPointer(sentence, charIndex, ms).catch((err) => {
      console.warn('Split failed:', err);
      tri.disabled = false;
    });
  });

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

/**
 * Karaoke-style highlight while `audio` plays: uses sentence.words[] (real
 * Azure timestamps, either from an audio import or tts-player.js's
 * ensureTtsWords()) to toggle `.is-speaking` on the `.row-char` spans
 * (buildTextEl() in split.js, each tagged with its own data-char-index) that
 * fall under the word currently playing. Snapshots sentence.words once, at
 * playback start -- if alignment is still in flight (ensureTtsWords() hasn't
 * resolved yet for a first-ever Speak on this sentence), this play simply
 * has no highlight; the next one will, once it's landed and persisted.
 * Cleans itself up on 'pause' (covers both a natural stop and player.stop()
 * pausing this same audio to start something else) and 'ended'.
 *
 * Timeline base: for a 'tts' sentence, `audio` IS the exact clip Azure just
 * transcribed, so w.offsetMilliseconds is already 0-based relative to it.
 * For an 'import' sentence, w.offsetMilliseconds is instead absolute within
 * the ORIGINAL uploaded recording (audio-import.js's resegmentByPunctuation()
 * never rebases it, only charStart/charEnd -- getSplitPointers()/
 * splitAtPointer() need that absolute value to re-slice from the pristine
 * source), while `audio` here plays sentence.referenceUrl, a clip already
 * sliced out starting at sentence.sourceOffsetMs -- so audio.currentTime
 * runs 0-based within just this sentence's slice, not the original
 * recording. Subtracting sourceOffsetMs re-bases the word timestamps onto
 * that same 0-based clip timeline; sourceOffsetMs is null for 'tts' (no
 * separate source file), so the subtraction is a no-op there.
 */
function wireWordHighlight(audio, sentence, row) {
  const words = sentence.words;
  if (!words || !words.length) return;
  const base = sentence.sourceOffsetMs || 0;
  const charEls = new Map();
  row.querySelectorAll('.row-char[data-char-index]').forEach((el) => {
    charEls.set(Number(el.dataset.charIndex), el);
  });
  let active = [];
  const clear = () => {
    for (const el of active) el.classList.remove('is-speaking');
    active = [];
  };
  const onTimeUpdate = () => {
    const ms = audio.currentTime * 1000;
    const word = words.find((w) => {
      const offset = w.offsetMilliseconds - base;
      return ms >= offset && ms < offset + w.durationMilliseconds;
    });
    clear();
    if (!word) return;
    for (let i = word.charStart; i < word.charEnd; i++) {
      const el = charEls.get(i);
      if (el) { el.classList.add('is-speaking'); active.push(el); }
    }
  };
  const stop = () => {
    audio.removeEventListener('timeupdate', onTimeUpdate);
    audio.removeEventListener('pause', stop);
    audio.removeEventListener('ended', stop);
    clear();
  };
  audio.addEventListener('timeupdate', onTimeUpdate);
  audio.addEventListener('pause', stop);
  audio.addEventListener('ended', stop);
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
    player.stop(); // stop any other playback first
    playBtn.disabled = true;
    try {
      // A reference clip already exists -- either sliced from an imported
      // file (permanent, never regenerated) or a previously synthesized take
      // for the current language (persisted the first time it was made, see
      // below) -- so play that directly instead of hitting TTS again.
      if (sentence.referenceBlob && sentence.referenceUrl) {
        const audio = new Audio(sentence.referenceUrl);
        wireWordHighlight(audio, sentence, row);
        await player.start(audio, playBtn);
        setStatus(status, '', 'info');
        return;
      }
      const locale = LOCALES[sentence.lang];
      if (hasCredentials()) {
        // Reuse cached audio for the same voice + text; synthesize only on a miss.
        const entry = await getTtsEntry(sentence.text, locale,
          () => setStatus(status, 'Synthesizing speech…', 'info'));
        // Persist this synthesized clip as the sentence's reference audio, so
        // it survives reload/sync and Speak never needs to call Azure again
        // for this sentence/language.
        sentence.referenceBlob = entry.blob;
        sentence.referenceUrl = entry.url;
        sentence.referenceSource = 'tts';
        persistSession();
        // Best-effort, not awaited: re-transcribing the clip to recover real
        // word timestamps (tts-player.js's ensureTtsWords()) takes its own
        // round trip and must never delay Speak actually starting. Guarded
        // against a stale landing -- by the time this resolves, the sentence
        // may have moved on (language toggled, split/merged, Speak clicked
        // again for a different clip).
        ensureTtsWords(entry, sentence.text, sentence.lang).then((words) => {
          if (!words || !words.length) return;
          if (sentence.referenceUrl !== entry.url) return;
          sentence.words = words;
          refreshRowText(sentence);
          persistSession();
        });
        ttsAudio.src = entry.url;
        wireWordHighlight(ttsAudio, sentence, row);
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
        // Note: this only replaces the user's own take (recordingBlob).
        // sentence.referenceBlob (what Speak plays) is a separate slot and is
        // untouched by recording -- an imported clip's reference audio in
        // particular is meant to stay available permanently.
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
    // A reference clip already on the sentence (imported, or a previously
    // synthesized take for this language) needs no network call at all --
    // only fall back to fetching/synthesizing one when there isn't one yet.
    if (!sentence.referenceBlob && !hasCredentials()) {
      setStatus(status, 'Export needs Azure credentials to fetch the reference audio.', 'error');
      return;
    }
    exportBtn.disabled = true;
    setStatus(status, 'Preparing export…', 'info');
    try {
      const locale = LOCALES[sentence.lang];
      let refBlob = sentence.referenceBlob;
      if (!refBlob) {
        const entry = await getTtsEntry(sentence.text, locale,
          () => setStatus(status, 'Fetching reference audio…', 'info'));
        refBlob = entry.blob;
        sentence.referenceBlob = entry.blob;
        sentence.referenceUrl = entry.url;
        sentence.referenceSource = 'tts';
        persistSession();
      }
      const refExt = refBlob.type === 'audio/wav' ? 'wav' : (refBlob.type === 'audio/mpeg' ? 'mp3' : 'audio');

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
        { name: `reference.${refExt}`, data: new Uint8Array(await refBlob.arrayBuffer()) },
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