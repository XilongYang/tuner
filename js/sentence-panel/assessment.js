// Score-result rendering: the overall score chips + per-word coloring
// (renderAssessment), each word's popover with its per-phoneme chips and
// "Retest" control (buildWordTip / playWord), and the color legend.

import { LOCALES } from '../lang.js';
import { assessPronunciation } from '../pron.js';
import { Recorder, decodeWavPcm16, encodeWav } from '../recorder.js';
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
    const tip = buildWordTip(w, sentence);
    span.appendChild(tip);

    span.addEventListener('click', () => {
      const wasOpen = span.classList.contains('is-open');
      // Only one word panel open at a time; switching (or closing) cancels any
      // in-progress per-word retest recording for whichever popover was open.
      stopActiveWordRetest();
      wordsWrap.querySelectorAll('.word.is-open').forEach((el) => el.classList.remove('is-open'));
      if (wasOpen) return; // toggle closed
      span.classList.add('is-open');
      // Every fresh open starts the Retest playback slot over from the
      // original recording's own word slice, discarding whatever was last
      // retested (see buildWordTip()'s resetForOpen doc comment).
      if (tip.resetForOpen) tip.resetForOpen();
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
 * Cut the exact span of a WAV recording Azure recognized as one word out into
 * its own standalone clip, given the offset/duration pron.js's parseResult()
 * already converted from Azure's Offset/Duration ticks. `blob` is always our
 * own encodeWav() output (recorder.js), so decodeWavPcm16() can read it back
 * directly -- no AudioContext decode needed. Re-encoding through encodeWav()
 * (rather than a raw byte slice) reuses the same normalize/resample pass
 * sliceReferenceClip() in audio-import.js already applies to sliced clips
 * elsewhere in the app, for the same reason: a short slice's own peak may be
 * quieter than the full recording's, so it's worth renormalizing on its own.
 */
async function sliceWordFromRecording(blob, offsetMs, durationMs) {
  const buf = await blob.arrayBuffer();
  const { samples, sampleRate } = decodeWavPcm16(buf);
  const start = Math.max(0, Math.round((offsetMs / 1000) * sampleRate));
  const end = Math.min(samples.length, Math.round(((offsetMs + durationMs) / 1000) * sampleRate));
  const slice = samples.slice(start, Math.max(start, end));
  return new Blob([encodeWav(slice, sampleRate)], { type: 'audio/wav' });
}

/**
 * Build a word's popover: a heading line + per-phoneme chips, plus a "Retest"
 * control that records just this one word, re-scores it against Azure, and
 * swaps the heading/phonemes to show the new result in its place.
 *
 * The retest result lives only in this closure (`retestWord` below) -- it never
 * touches `w` or `sentence.assessment` and is never passed to persistSession(),
 * so it is purely a this-session, this-popover scratchpad: closing the popover,
 * reopening the word, or reloading the page loses it. The returned element
 * carries a `resetForOpen()` method (see below) that renderAssessment() calls
 * every time this word's popover is (re)opened, so a previous Retest take
 * from earlier in the same session never lingers into the next open either.
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

    // Hear either the last Retest take, or -- before any Retest -- the exact
    // span of the ORIGINAL recording (sentence.recordingBlob, the one that
    // was actually scored) that Azure recognized as this word. Both play
    // through the same button/URL slot: `originalUrl` (below) is a cached,
    // lazily-sliced clip of the original recording that resetForOpen() below
    // (re)installs into `retestUrl` on every fresh open, and a real Retest
    // simply overwrites `retestUrl` with its own take the same way it always
    // has. Object URLs, not the Recorder's own (which gets revoked on
    // dispose() below), so playback keeps working after the mic is released.
    const playBtn = document.createElement('button');
    playBtn.className = 'tip-retest-play-btn';
    playBtn.type = 'button';
    playBtn.textContent = '▶';
    playBtn.title = 'Play what you said for this word (from your recording)';
    playBtn.hidden = true;
    let retestUrl = null;
    let originalUrl = null; // cached slice of the original recording; never revoked by a Retest overwrite
    let originalUrlPromise = null;

    /** Lazily slice+cache the original recording's span for this word. Memoized
     *  so reopening the popover doesn't re-decode/re-encode the WAV every time.
     *  Resolves to null when there's nothing to slice (no timing data on this
     *  word -- e.g. an Omission, or a stale pre-upgrade assessment -- or no
     *  original recording at all). */
    function ensureOriginalUrl() {
      if (originalUrlPromise) return originalUrlPromise;
      if (w.offsetMs == null || w.durationMs == null || !(w.durationMs > 0) || !sentence.recordingBlob) {
        originalUrlPromise = Promise.resolve(null);
        return originalUrlPromise;
      }
      originalUrlPromise = sliceWordFromRecording(sentence.recordingBlob, w.offsetMs, w.durationMs)
        .then((blob) => { originalUrl = URL.createObjectURL(blob); return originalUrl; })
        .catch(() => null);
      return originalUrlPromise;
    }

    /** Called by renderAssessment() every time this word's popover is
     *  (re)opened: discards any earlier Retest take (per-open, not just
     *  per-page-load -- reopening always starts fresh from the original
     *  recording) and, once the slice is ready, points playBtn at it. Guarded
     *  against a Retest finishing (or another open superseding this one)
     *  while the slice was still being decoded. */
    async function resetForOpen() {
      if (retestWord !== null || (retestUrl && retestUrl !== originalUrl)) {
        if (retestUrl && retestUrl !== originalUrl) URL.revokeObjectURL(retestUrl);
        retestUrl = null;
        retestWord = null;
        renderScore();
      }
      playBtn.title = 'Play what you said for this word (from your recording)';
      playBtn.hidden = true;
      setRetestStatus('', 'info');
      const url = await ensureOriginalUrl();
      // A real Retest may have started (or finished) while the slice was
      // still decoding -- don't clobber it with the stale original clip.
      if (retestWord !== null || (recorder && recorder.isRecording)) return;
      if (url) {
        retestUrl = url;
        playBtn.hidden = false;
      }
    }

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

          // Never revoke `originalUrl` here -- it's cached across opens (see
          // ensureOriginalUrl()) and reused the next time this popover opens
          // fresh, even after this Retest take is later discarded too.
          if (retestUrl && retestUrl !== originalUrl) URL.revokeObjectURL(retestUrl);
          retestUrl = URL.createObjectURL(blob);
          playBtn.title = 'Play your last retest take';
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

    tip.resetForOpen = resetForOpen;
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
