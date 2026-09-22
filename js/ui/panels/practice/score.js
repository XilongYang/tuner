// What a score looks like: four numbers, the sentence again with every word
// marked, and a popover per word holding its phonemes and a Retest.
//
// The four numbers are the summary; the words are where the summary comes
// from, and the only part worth acting on -- "76 overall" tells you nothing
// about what to say again. So a word is clickable: it says what it heard, how
// each phoneme scored, plays the word as it should sound, plays what you
// actually said, and lets you say it again.
//
// A retest is deliberately not kept. It is not a score for the sentence: the
// sentence's score describes one reading of the whole sentence, and swapping a
// better attempt at one word into it would make it describe nothing. So it
// lives in this closure, and reopening the word is a fresh start -- which also
// means a take is never left lying around claiming to be a result.

import { el, button } from '../../dom.js';
import { chars } from '../../../model/geometry.js';
import { overallScores, wordMark, wordHeadline, wordRange, accuracyLevel, LEGEND } from '../../../model/score.js';

/**
 * @param {object} spec
 * @param {object} spec.sentence
 * @param {object} spec.actions `wordClip`, `scoreWord`, `speakWord`.
 * @param {object} spec.player
 * @param {() => object} spec.createRecorder A recorder of this block's own: a
 *   retest records while the row is not, and the row's recorder belongs to the
 *   take the sentence keeps.
 * @param {() => boolean} [spec.rowIsRecording] Whether the row is recording.
 * @param {(busy: boolean) => void} [spec.onBusy] Told while a retest holds the
 *   microphone, so the row can refuse to start its own recording.
 */
export function createScoreBlock({
  sentence: initial, actions, player, createRecorder, rowIsRecording = () => false, onBusy = () => {},
}) {
  let sentence = initial;
  const element = el('div', { class: 'row-result', hidden: true });
  const scores = el('div', { class: 'score-grid' });
  const wordsLine = el('div', { class: 'words-line' });
  // One retest at a time in this block, and it is stopped whenever the word it
  // belongs to closes.
  let active = null;

  element.append(scores, wordsLine, legend());

  function render() {
    const assessment = sentence.assessment;
    element.hidden = !assessment;
    closeAll();
    if (!assessment) return;

    scores.replaceChildren(...overallScores(assessment).map((score) => el('div', {
      class: 'score-chip', dataset: { level: score.level },
    }, [
      el('span', { class: 'score-value', text: String(score.value) }),
      el('span', { class: 'score-label', text: score.label }),
    ])));

    wordsLine.replaceChildren(...(assessment.words || []).map((word) => wordSpan(word)));
  }

  function closeAll() {
    active?.stop();
    active = null;
    for (const open of wordsLine.querySelectorAll('.word.is-open')) open.classList.remove('is-open');
  }

  function wordSpan(word) {
    const { level, error } = wordMark(word);
    const span = el('span', {
      class: 'word',
      role: 'button',
      tabIndex: 0,
      dataset: { ...(level ? { level } : {}), ...(error ? { error } : {}) },
      'aria-label': wordHeadline(word),
    });
    // One span per character, so practising from memory can cover a word with
    // as many marks as it has characters -- its length is a cue, its letters
    // are the answer -- while the word itself stays one click target.
    for (const ch of chars(word.word || '')) span.append(el('span', { class: 'word-char', text: ch }));

    const tip = wordTip(word);
    span.append(tip.element);

    const toggle = () => {
      const wasOpen = span.classList.contains('is-open');
      // Only one open at a time: two popovers overlap, and a retest in a
      // popover nobody is looking at is a microphone nobody meant to leave on.
      closeAll();
      if (wasOpen) return;
      span.classList.add('is-open');
      active = tip;
      tip.open();
    };

    span.addEventListener('click', toggle);
    span.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
    return span;
  }

  /** One word's popover. Returns its element plus the open/stop it answers to. */
  function wordTip(word) {
    const element = el('span', { class: 'word-tip' });
    // A click on the Retest button must not reach the word underneath, which
    // would shut the popover the moment anything in it was pressed.
    element.addEventListener('click', (event) => event.stopPropagation());

    const head = el('span', { class: 'tip-head' });
    const phonemes = el('span', { class: 'tip-phonemes' });
    const status = el('span', { class: 'tip-retest-status', hidden: true });

    // The last retest's result, if there is one. Never written anywhere: see
    // the header.
    let retest = null;
    // What the play button plays: the span of the take that was scored, until
    // a retest replaces it with the new one.
    let clip = null;
    let originalClip = null;
    let originalClipRequest = null;
    let recorder = null;

    function say(message, kind = 'info') {
      status.hidden = !message;
      status.textContent = message || '';
      status.dataset.kind = kind;
    }

    function renderScore() {
      const shown = retest || word;
      head.removeAttribute('data-level');
      head.textContent = wordHeadline(shown, { name: word.word, prefix: retest ? 'Retest: ' : '' });
      // An omission or an insertion has no accuracy to band: one was never
      // spoken and the other was never asked for.
      const banded = shown.errorType !== 'Omission' && shown.errorType !== 'Insertion';
      if (banded) head.dataset.level = accuracyLevel(shown.accuracy);

      const list = shown.phonemes || [];
      phonemes.hidden = !list.length;
      phonemes.replaceChildren(...list.map((phoneme) => el('span', {
        class: 'ph', dataset: { level: accuracyLevel(phoneme.accuracy) },
      }, [
        el('b', { text: phoneme.phoneme }),
        el('i', { text: String(Math.round(phoneme.accuracy ?? 0)) }),
      ])));
    }

    const playBtn = button({
      class: 'tip-play', text: '▶', hidden: true,
      title: 'Hear what you said for this word',
      onClick: () => {
        if (!clip) return;
        player.play(clip, `${sentence.id}:word:${word.word}`);
      },
    });

    const retestBtn = button({
      class: 'tip-retest-btn', text: 'Retest',
      title: 'Say this word again and score it on its own',
      onClick: () => (recorder ? finishRetest() : startRetest()),
    });

    element.append(head, phonemes, el('span', { class: 'tip-retest' }, [retestBtn, playBtn, status]));

    async function startRetest() {
      if (rowIsRecording()) {
        say('The row is already recording.', 'error');
        return;
      }
      player.stop();
      try {
        recorder = createRecorder();
        await recorder.start();
      } catch (err) {
        recorder = null;
        say(`Cannot record: ${err.message}`, 'error');
        return;
      }
      onBusy(true);
      retestBtn.textContent = 'Stop';
      retestBtn.classList.add('is-recording');
      say('Recording…', 'recording');
    }

    async function finishRetest() {
      const taking = recorder;
      recorder = null;
      retestBtn.disabled = true;
      retestBtn.textContent = 'Retest';
      retestBtn.classList.remove('is-recording');

      try {
        const take = await taking.stop();
        if (!take?.blob) {
          say('Nothing was recorded.', 'error');
          return;
        }

        clip = take.blob;
        playBtn.hidden = false;
        playBtn.title = 'Hear your retest';

        say('Scoring…', 'busy');
        const outcome = await actions.scoreWord(word.word, sentence.lang, take.blob);
        if (!outcome.ok) {
          say(describe(outcome.reason), 'error');
          return;
        }
        retest = outcome.word;
        renderScore();
        say('');
      } catch (err) {
        say(`Retest failed: ${err.message}`, 'error');
      } finally {
        // Here rather than after the stop: a stop that throws leaves this
        // recorder unreachable -- `stop()` below has already been given up on
        // it -- and it would hold the microphone for the life of the page.
        taking.dispose?.();
        onBusy(false);
        retestBtn.disabled = false;
      }
    }

    /**
     * Cut the word out of the take, once, and keep it for the next open.
     *
     * Decoding a whole recording to hear one word is worth doing lazily and
     * worth doing once; a word with no timings simply has nothing to play.
     */
    function ensureOriginalClip() {
      if (!originalClipRequest) {
        originalClipRequest = wordRange(word)
          ? actions.wordClip(sentence.id, word).catch(() => null)
          : Promise.resolve(null);
      }
      return originalClipRequest;
    }

    return {
      element,

      /**
       * Every open starts over: no retest, no take, and the play button back on
       * the original recording's own span of this word.
       *
       * Not just per page load -- per open. A result from ten minutes ago
       * sitting under a word, indistinguishable from the score that is actually
       * stored, is worse than no result at all.
       */
      async open() {
        retest = null;
        clip = null;
        playBtn.hidden = true;
        playBtn.title = 'Hear what you said for this word';
        say('');
        renderScore();

        // Best-effort and not awaited before the rest: hearing the word is why
        // the popover was opened, and the clip below can arrive after it.
        actions.speakWord(word.word, sentence.lang)
          .then((audio) => audio && player.play(audio, `${sentence.id}:say:${word.word}`))
          .catch(() => {});

        originalClip = await ensureOriginalClip();
        // A retest may have started while the take was being decoded; its own
        // clip is the newer answer.
        if (recorder || retest || clip) return;
        if (originalClip) {
          clip = originalClip;
          playBtn.hidden = false;
        }
      },

      /** The popover is closing, or the row is repainting: let go of the microphone. */
      stop() {
        if (!recorder) return;
        recorder.dispose?.();
        recorder = null;
        onBusy(false);
        retestBtn.textContent = 'Retest';
        retestBtn.classList.remove('is-recording');
        say('');
      },
    };

    function describe(reason) {
      if (reason === 'no-credentials') return 'Scoring needs a key and region (Settings).';
      if (reason === 'no-recording') return 'Nothing was recorded.';
      return `Could not score it: ${reason}`;
    }
  }

  function legend() {
    return el('div', { class: 'legend' }, LEGEND.map((item) => el('span', { class: 'legend-item' }, [
      el('i', { dataset: item.level ? { level: item.level } : { error: item.error } }),
      el('span', { text: item.label }),
    ])));
  }

  render();

  return {
    element,
    /** A new version of the same sentence: repaint if what is shown changed. */
    update(next) {
      const same = next.assessment === sentence.assessment;
      sentence = next;
      if (!same) render();
    },
    /** The row is going away. Nothing here may outlive it -- least of all a recorder. */
    dispose: closeAll,
  };
}
