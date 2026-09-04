// Score-result rendering: the overall score chips + per-word coloring
// (renderAssessment), each word's popover with its per-phoneme chips and
// "Retest" control (buildWordTip / playWord), and the color legend.

import { LOCALES } from '../lang.js';
import { assessPronunciation } from '../pron.js';
import { Recorder } from '../recorder.js';
import { hasCredentials } from '../config.js';
import { markSentenceBusy, unmarkSentenceBusy } from '../state.js';
import { getTtsEntry, player, ttsAudio } from '../tts-player.js';
import { stopActiveWordRetest, setActiveWordRetest } from './split.js';

/** Map an accuracy score to a display level. */
export function accuracyLevel(score) {
  if (score >= 80) return 'good';
  if (score >= 60) return 'mid';
  return 'bad';
}

export const ERROR_LABELS = {
  None: '',
  Mispronunciation: 'mispronounced',
  Omission: 'omission',
  Insertion: 'insertion',
  UnexpectedBreak: 'unexpected break',
  MissingBreak: 'missing break',
  Monotone: 'monotone',
};

/** Render the assessment: overall scores + per-word coloring. */
export function renderAssessment(container, a, sentence) {
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
    // Each character of the word gets its own inline span so hidden mode
    // (see .sentence-row.is-hidden .word .word-char in styles.css) can mask
    // it as a "#" per character rather than one block for the whole word --
    // the word text/click/hover behavior below is unaffected, it's still all
    // on the outer `span`.
    for (const ch of Array.from(w.word || '')) {
      const charEl = document.createElement('span');
      charEl.className = 'word-char';
      charEl.textContent = ch;
      span.appendChild(charEl);
    }

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
          setActiveWordRetest(null);
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
        setActiveWordRetest({
          stop() {
            if (recorder) { recorder.dispose(); recorder = null; }
            retestBtn.textContent = '🎙 Retest';
            retestBtn.classList.remove('is-recording');
            setRetestStatus('', 'info');
            unmarkSentenceBusy(sentence.id);
          },
        });
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
    '<span class="legend-item"><i data-error="insertion"></i>Insertion</span>';
  return legend;
}
