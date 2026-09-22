// One sentence's row: its text, its controls, and a line for whatever the last
// action had to say.
//
// A row is created once per sentence and updated in place afterwards (see
// ../../dom.js's reconcile). Anything with a lifecycle -- the recorder, the
// in-flight state of a button -- lives in the row's own closure, keyed to the
// sentence id it was built for, so a repaint triggered by a background sync
// cannot interrupt a recording or lose which button is busy.
//
// The row dispatches commands and renders their outcomes. It does not touch the
// database or the network, and it does not decide anything: what a failed
// score means, or whether a split can keep its audio, is the command's answer
// to report.

import { el, button } from '../../dom.js';
import { wordAt } from '../../../model/transcript.js';
import { renderSentenceText, setSpeaking } from './sentence-text.js';
import { createScoreBlock } from './score.js';

/** What to say for an outcome a command reports by name rather than by message. */
const REASONS = {
  gone: 'That sentence is no longer here.',
  superseded: 'Something changed while that was running, so it was not applied.',
  refused: 'That split would leave an empty half.',
  'no-credentials': 'Add your Azure key and region in Settings first.',
  'no-recording': 'Record this sentence before scoring it.',
  'no-reference-audio': 'This sentence has no reference audio to play.',
  'no-selection': 'Select a word first.',
  'not-a-word': 'That selection has no word in it.',
  'already-recording': 'Already recording.',
  'not-recording': 'Nothing was being recorded.',
};

const describe = (reason) => REASONS[reason] ?? reason;

/**
 * @param {object} spec
 * @param {object} spec.sentence
 * @param {number} spec.index Its position in the session, for the row's number.
 * @param {object} spec.actions Command dispatchers, already bound to the store.
 * @param {object} spec.player
 * @param {(id: string) => object} spec.recorderFor
 * @param {() => object} spec.createRecorder For a per-word retest, which records
 *   without the sentence's own take being replaced.
 * @param {(id: string, selected: boolean) => void} spec.onSelect
 * @param {(id: string) => boolean} spec.isSelected
 * @param {(id: string) => boolean} spec.isSelectable
 */
export function createRow({
  sentence: initial, index, actions, player, recorderFor, createRecorder, onSelect, isSelected, isSelectable,
}) {
  const sentenceId = initial.id;
  let sentence = initial;
  let position = index;
  let busy = false;

  const row = el('div', { class: 'sentence-row' });

  // Ticking rows is how sentences are chosen for merging. The checkbox lives on
  // the row rather than in a mode of its own, so the choice can be made while
  // reading -- and it survives a repaint, because reconcile updates this row
  // instead of rebuilding it.
  const selectBox = el('input', { class: 'row-select', type: 'checkbox' });
  selectBox.title = 'Select this sentence for merging';
  selectBox.addEventListener('change', () => onSelect?.(sentenceId, selectBox.checked));
  const number = el('span', { class: 'row-index-num' });
  const head = el('div', { class: 'row-index' }, [number, selectBox]);
  const textHost = el('div', { class: 'sentence-text-host' });
  const status = el('p', { class: 'sentence-status', hidden: true });

  const say = (message, kind = 'info') => {
    status.hidden = !message;
    status.textContent = message || '';
    status.dataset.kind = kind;
  };

  /**
   * Run one action with the row marked busy.
   *
   * Every control is disabled for the duration and re-enabled afterwards, on
   * success and on failure alike. Disabling on entry and re-enabling only on
   * success is how a control ends up permanently dead after an early return.
   */
  async function run(label, fn) {
    if (busy) return;
    busy = true;
    refreshControls();
    say(label, 'busy');
    try {
      const outcome = await fn();
      if (outcome && outcome.ok === false) say(describe(outcome.reason), 'error');
      else if (outcome?.message) say(outcome.message, 'info');
      else say('');
      return outcome;
    } catch (err) {
      say(err.message, 'error');
    } finally {
      busy = false;
      refreshControls();
    }
  }

  const speakBtn = button({
    class: 'btn', text: 'Speak', title: 'Play the reference reading',
    onClick: () => run('Preparing the reading…', async () => {
      const outcome = await actions.speak(sentenceId);
      return outcome.ok && outcome.synthesized ? { ...outcome, message: '' } : outcome;
    }),
  });

  const recordBtn = button({
    class: 'btn', text: 'Record',
    onClick: () => {
      const recorder = recorderFor(sentenceId);
      if (recorder.isRecording) {
        return run('Saving the take…', async () => {
          const outcome = await actions.stopRecording(sentenceId, recorder);
          refreshControls();
          return outcome;
        });
      }
      return run('Starting…', async () => {
        const outcome = await actions.startRecording(sentenceId, recorder);
        refreshControls();
        return outcome;
      });
    },
  });

  const playbackBtn = button({
    class: 'btn', text: 'Playback', title: 'Hear your own take',
    onClick: () => {
      if (!sentence.recording) return;
      player.play(sentence.recording, `${sentenceId}:playback`);
    },
  });

  const scoreBtn = button({
    class: 'btn', text: 'Score',
    onClick: () => run('Scoring…', () => actions.score(sentenceId)),
  });

  // Two chips rather than two buttons, and first rather than last. Both are
  // settings on the sentence rather than things to do with it, and both are
  // pressed rarely -- the language is usually right already, and hiding is
  // mostly done for every sentence at once from the header. At full button
  // weight they crowded out Speak and Record, which are the whole point of the
  // row.
  const hideBtn = button({
    class: 'row-chip',
    onClick: () => actions.toggleHidden(sentenceId, !sentence.hidden),
  });

  const langBtn = button({
    class: 'row-chip',
    title: 'Switch this sentence between Japanese and English',
    onClick: () => actions.setLanguage(sentenceId, sentence.lang === 'ja' ? 'en' : 'ja'),
  });

  // Not through run(): this one opens a picker and waits for a person, and a
  // row that said "Adding…" for as long as they took to choose would be
  // describing them rather than itself. The picker reports its own progress;
  // the row says what came of it.
  const vocabBtn = button({
    class: 'btn', text: 'Add vocab', title: 'Pick words from this sentence to keep',
    onClick: async () => {
      const outcome = await actions.addVocab(sentenceId);
      if (outcome?.ok === false) say(describe(outcome.reason), 'error');
      else if (outcome?.added) say(`Added ${outcome.added} to the vocabulary library.`, 'info');
      else say('');
    },
  });

  const controls = el('div', { class: 'sentence-controls' }, [
    langBtn, hideBtn, speakBtn, recordBtn, playbackBtn, scoreBtn, vocabBtn,
  ]);

  // The score: four numbers, every word marked, and a popover per word. Held
  // as its own thing because it has a lifetime -- an open popover, a retest
  // recording -- and the row has to be able to end it.
  let retesting = false;
  const score = createScoreBlock({
    sentence: initial,
    actions,
    player,
    createRecorder,
    rowIsRecording: () => recorderFor(sentenceId).isRecording,
    onBusy: (busy) => { retesting = busy; refreshControls(); },
  });

  const body = el('div', { class: 'row-body' }, [textHost, controls, score.element, status]);
  row.append(head, body);

  // Follow the reference reading along the text, a word at a time.
  //
  // Only the reference clip: it is the one whose words are timed. A recording
  // of your own has no timings, and the browser's own voice reports none, so
  // both simply leave the text alone rather than lighting something arbitrary.
  //
  // The clip starts where the sentence starts in the source file, so playback
  // time has to be put back on the source's timeline before the words make
  // sense -- an imported sentence's words are stamped on that timeline, not on
  // its own clip's.
  // Not optional calls: a player without these is a broken player, and failing
  // here is how that gets noticed rather than quietly losing the highlight.
  const stopFollowing = player.onTime((playingToken, elapsedMs) => {
    if (playingToken !== sentenceId) return;
    const base = sentence.referenceSource === 'import' ? (sentence.sourceOffsetMs ?? 0) : 0;
    setSpeaking(textHost, wordAt(sentence.words, base + elapsedMs));
  });

  const stopWatchingPlayback = player.subscribe((playingToken) => {
    if (playingToken !== sentenceId) setSpeaking(textHost, null);
    refreshControls();
  });

  function refreshControls() {
    const recorder = recorderFor(sentenceId);
    const recording = recorder.isRecording;

    // Two digits, so a list of ten or more does not shift as it is read.
    number.textContent = String(position + 1).padStart(2, '0');
    selectBox.setAttribute('aria-label', `Select sentence ${position + 1} for merging`);
    const selected = Boolean(isSelected?.(sentenceId));
    selectBox.checked = selected;
    row.classList.toggle('is-selected', selected);
    // A merge joins a run, so a sentence that would break the run cannot be
    // ticked at all -- better than accepting the tick and refusing the merge.
    const selectable = isSelectable ? isSelectable(sentenceId) : true;
    selectBox.disabled = !selectable;
    selectBox.title = selectable
      ? 'Select this sentence for merging'
      : 'Only sentences next to the ones already selected can be merged with them';

    row.classList.toggle('is-recording', recording || retesting);
    // Record stays live while recording, or there would be no way to stop. A
    // retest holds the microphone, so the row cannot start its own take while
    // one is running.
    recordBtn.disabled = (busy && !recording) || retesting;
    recordBtn.textContent = recording ? 'Stop' : 'Record';

    for (const control of [speakBtn, scoreBtn, hideBtn, langBtn, vocabBtn]) {
      control.disabled = busy || recording || retesting;
    }
    playbackBtn.disabled = busy || recording || !sentence.recording;
    playbackBtn.hidden = !sentence.recording;
    // Pressed while it is playing, because pressing it again is what stops it.
    // The rule was in the stylesheet with nothing setting the class.
    const playingBack = player.isPlaying?.(`${sentenceId}:playback`) ?? false;
    playbackBtn.classList.toggle('is-playing', playingBack);
    playbackBtn.title = playingBack ? 'Stop' : 'Hear your own take';
    scoreBtn.hidden = !sentence.recording;
    // A word joins the vocabulary library with a recording of itself, cut from
    // the reading of the sentence it came from. A sentence that has never been
    // spoken has no reading to cut from, and a vocabulary entry whose audio is
    // an imitation produced later is not the same thing at all -- so there is
    // nothing to pick here until the words have been placed in real audio.
    vocabBtn.hidden = !sentence.words?.length;

    // The scored words are the sentence again, so they are covered with it.
    row.classList.toggle('is-hidden-text', Boolean(sentence.hidden));
    hideBtn.textContent = sentence.hidden ? 'Show' : 'Hide';
    hideBtn.title = sentence.hidden ? 'Show this sentence\'s text' : 'Hide this sentence\'s text';
    hideBtn.setAttribute('aria-pressed', String(Boolean(sentence.hidden)));
    langBtn.textContent = sentence.lang === 'ja' ? 'JA' : 'EN';
  }

  function renderText() {
    textHost.replaceChildren(renderSentenceText(sentence, {
      onSplit: (charIndex, ms) => run('Splitting…', async () => {
        const outcome = await actions.split(sentenceId, charIndex, ms);
        if (outcome.ok && outcome.audioFollowed === false) {
          return { ...outcome, message: 'Split. There was no audio timing at that position, so neither half kept a clip.' };
        }
        return outcome;
      }),
    }));
  }


  /** Repaint for a new version of the same sentence, possibly at a new position. */
  function update(next, nextIndex = position) {
    const textChanged = next.text !== sentence.text
      || next.hidden !== sentence.hidden
      || next.words !== sentence.words;

    sentence = next;
    position = nextIndex;
    if (textChanged) renderText();
    score.update(next);
    refreshControls();
  }

  renderText();
  refreshControls();

  return {
    element: row,
    update,
    say,
    /**
     * Let go of anything in flight without taking the row away.
     *
     * The workspace is being released -- a session opened, a new one started --
     * and a row whose id survives that stays on screen and stays working. What
     * must not survive it is a retest still holding the microphone.
     */
    release() {
      score.dispose();
    },

    /** Called when this row leaves the list, so nothing keeps calling into it. */
    dispose() {
      stopFollowing();
      stopWatchingPlayback();
      // A popover left open would be holding the microphone for a retest.
      score.dispose();
    },
  };
}
