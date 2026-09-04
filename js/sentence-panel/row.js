// Per-sentence row: DOM construction (renderRow) and the row-level button
// wiring (Speak / Record / Playback / Score / Export) in wireRow.

import { LOCALES } from '../lang.js';
import { speakWithBrowser } from '../tts.js';
import { assessPronunciation } from '../pron.js';
import { makeZip } from '../zip.js';
import { hasCredentials, getVoice } from '../config.js';
import { persistSession, markSentenceBusy, unmarkSentenceBusy } from '../state.js';
import { getTtsEntry, player, ttsAudio } from '../tts-player.js';
import { buildTextEl, paintHidden, applyHidden } from './split.js';
import { renderAssessment } from './assessment.js';
import { slugify, downloadBlob } from './export-utils.js';

export function renderRow(sentence, index) {
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