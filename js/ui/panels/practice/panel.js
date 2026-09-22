// The practice panel: the text box, the Split control, and the list of
// sentences.
//
// It subscribes to the session store and reconciles the list by sentence id, so
// a repaint -- including one caused by a sync landing in the background --
// updates the rows that changed and leaves the rest of the DOM, and everything
// living in it, exactly where it was.
//
// It owns the recorders, keyed by sentence id, because a recorder is a
// lifecycle and records hold data. A sentence that goes away takes its recorder
// with it.

import { el, button, reconcile } from '../../dom.js';
import { createRow } from './row.js';
import { isSessionLocked } from '../../../model/geometry.js';
import { derivedInputText, mergeSelectable } from '../../../model/session.js';

/**
 * @param {object} spec
 * @param {Element} spec.container
 * @param {import('../../../app/store.js').SessionStore} spec.store
 * @param {object} spec.actions
 * @param {object} spec.player
 * @param {() => object} spec.createRecorder
 */
export function createPracticePanel({ container, store, actions, player, createRecorder }) {
  const recorders = new Map();
  const rows = new Map();

  const input = el('textarea', {
    class: 'practice-input',
    rows: 6,
    placeholder: 'Paste or type what you want to practise, then press Split.',
    'aria-label': 'Practice text',
  });
  const splitBtn = button({ class: 'btn primary', text: 'Split', onClick: onSplitClicked });
  const importBtn = button({ class: 'btn', text: 'Import audio', onClick: () => fileInput.click() });
  const fileInput = el('input', { class: 'practice-file', type: 'file', accept: 'audio/*', hidden: true });
  const status = el('p', { class: 'practice-status', hidden: true });
  const count = el('span', { class: 'practice-count' });
  const list = el('div', { class: 'sentence-list' });

  // Which sentences are ticked for merging. Held here rather than on the rows,
  // so it survives a row being rebuilt and so the bar can read it in one place.
  // Ids that are no longer in the session are dropped on every repaint -- a
  // sentence that was merged or deleted elsewhere must not stay selected.
  const selection = new Set();
  // Which rows may be ticked, recomputed on every repaint. A panel-level
  // binding rather than a local one, because the rows read it through a closure
  // handed to them once, at creation.
  let selectable = new Set();
  const mergeLabel = el('span', { class: 'merge-bar-label' });
  const mergeBtn = button({ class: 'btn primary', text: 'Merge', onClick: onMergeClicked });
  const clearSelection = button({
    class: 'btn', text: 'Clear',
    onClick: () => { selection.clear(); render(store.get()); },
  });
  const mergeBar = el('div', { class: 'merge-bar', hidden: true }, [mergeLabel, mergeBtn, clearSelection]);

  function onSelect(sentenceId, selected) {
    if (selected) selection.add(sentenceId);
    else selection.delete(sentenceId);
    render(store.get());
  }

  /**
   * Merge the ticked sentences, in the order they appear rather than the order
   * they were ticked -- the command works on a run of adjacent sentences, and
   * which end was clicked first says nothing about where they sit.
   */
  async function onMergeClicked() {
    const session = store.get();
    const ordered = (session?.sentences ?? [])
      .map((sentence) => sentence.id)
      .filter((id) => selection.has(id));
    if (ordered.length < 2) return;

    mergeBtn.disabled = true;
    say('Merging…', 'busy');
    try {
      const outcome = await actions.merge(ordered);
      if (!outcome.ok) {
        say(describeMerge(outcome.reason), 'error');
        return;
      }
      selection.clear();
      say(outcome.audioFollowed === false
        ? 'Merged. The audio could not be re-cut, so the merged sentence has no clip.'
        : `Merged ${ordered.length} sentences.`);
    } finally {
      mergeBtn.disabled = false;
      render(store.get());
    }
  }

  const say = (message, kind = 'info') => {
    status.hidden = !message;
    status.textContent = message || '';
    status.dataset.kind = kind;
  };

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    // Cleared immediately, so choosing the same file twice in a row still fires.
    fileInput.value = '';
    if (!file) return;

    splitBtn.disabled = true;
    importBtn.disabled = true;
    try {
      const outcome = await actions.importAudio(file, (progress) => say(progressText(progress), 'busy'));
      say(outcome.ok
        ? `Imported ${outcome.count} sentence${outcome.count === 1 ? '' : 's'}${outcome.withAudio < outcome.count ? `, ${outcome.count - outcome.withAudio} without audio` : ''}.`
        : describeImport(outcome.reason), outcome.ok ? 'info' : 'error');
    } finally {
      splitBtn.disabled = false;
      importBtn.disabled = false;
    }
  });

  function onSplitClicked() {
    const session = store.get();
    // Once a session has been split the same control starts a new one: there is
    // nothing left to split, and the text box is showing a session's text
    // rather than something waiting to be split.
    if (isSessionLocked(session?.splitMode ?? 'auto', session?.sentences?.length ?? 0)) {
      actions.startNew();
      say('');
      return;
    }
    const outcome = actions.splitText(input.value);
    say(outcome.ok ? '' : 'There is nothing to split yet.', outcome.ok ? 'info' : 'error');
  }

  function recorderFor(sentenceId) {
    if (!recorders.has(sentenceId)) recorders.set(sentenceId, createRecorder());
    return recorders.get(sentenceId);
  }

  /** Let go of the recorders of sentences that are no longer here. */
  function pruneRecorders(liveIds) {
    for (const [id, recorder] of recorders) {
      if (!liveIds.has(id)) {
        recorder.dispose();
        recorders.delete(id);
      }
    }
  }

  function render(session) {
    const sentences = session?.sentences ?? [];
    const locked = isSessionLocked(session?.splitMode ?? 'auto', sentences.length);

    // The text box shows what the session is made of. For an imported session
    // that is the transcript, which is derived rather than typed.
    const text = session ? (derivedInputText(session) ?? '') : '';
    if (document.activeElement !== input && input.value !== text) input.value = text;

    // Once a session is split, the box has nothing left to show: its text is
    // the sentences below, each editable in its own right, and editing it here
    // would do nothing to them -- for an imported session it cannot even be
    // edited, since the clips were cut to match the transcript. So it goes
    // away rather than sitting there greyed out inviting the attempt. It stays
    // read-only as well, for the moment between a repaint and the eye.
    input.hidden = locked;
    input.readOnly = locked;
    input.classList.toggle('is-locked', locked);
    // Split has no text to act on any more, and importing a file would discard
    // the session on screen rather than import into it.
    splitBtn.textContent = locked ? 'New session' : 'Split';
    importBtn.hidden = locked;
    count.textContent = sentences.length ? `${sentences.length} sentence${sentences.length === 1 ? '' : 's'}` : '';

    const liveIds = new Set(sentences.map((s) => s.id));
    for (const id of [...selection]) if (!liveIds.has(id)) selection.delete(id);

    // Only a run can be merged, so only the sentences that keep the selection a
    // run can be ticked: the rest are shown, but not pickable.
    selectable = mergeSelectable(session, selection);

    reconcile(list, sentences, {
      key: (sentence) => sentence.id,
      create: (sentence, index) => {
        const row = createRow({
          sentence,
          index,
          actions,
          player,
          recorderFor,
          createRecorder,
          onSelect,
          isSelected: (id) => selection.has(id),
          isSelectable: (id) => selectable.has(id),
        });
        rows.set(sentence.id, row);
        return row.element;
      },
      update: (_element, sentence, index) => rows.get(sentence.id)?.update(sentence, index),
    });

    for (const id of [...rows.keys()]) {
      if (liveIds.has(id)) continue;
      rows.get(id)?.dispose?.();
      rows.delete(id);
    }
    pruneRecorders(liveIds);

    mergeBar.hidden = selection.size === 0;
    mergeLabel.textContent = `${selection.size} selected`;
    // Shown from one tick so the selection is visible and undoable, but merging
    // needs two.
    mergeBtn.hidden = selection.size < 2;
  }

  container.append(
    el('div', { class: 'practice-input-area' }, [input, el('div', { class: 'practice-controls' }, [splitBtn, importBtn, count]), status, fileInput]),
    mergeBar,
    list,
  );

  const unsubscribe = store.subscribe((session) => render(session));
  render(store.get());

  return {
    /** Release everything this panel holds. Called when the session on screen is replaced. */
    release() {
      for (const recorder of recorders.values()) recorder.dispose();
      recorders.clear();
      // A row that survives this (the same session reopened keeps its sentence
      // ids) keeps its place on screen, but not a retest that was recording
      // into it.
      for (const row of rows.values()) row.release?.();
      // Rows are deliberately left alone: release() runs when the session on
      // screen is replaced, and reopening the same session keeps the same
      // sentence ids -- those rows stay on screen and must stay working.
      // A row is disposed when it actually leaves the list, above.
    },
    say,
    destroy() {
      unsubscribe();
      this.release();
      for (const row of rows.values()) row.dispose?.();
      rows.clear();
    },
  };
}

const progressText = (progress) => ({
  transcribing: 'Transcribing the audio…',
  segmenting: 'Splitting it into sentences…',
  decoding: 'Decoding the file…',
  cutting: progress.total ? `Cutting clips ${progress.done ?? 0} / ${progress.total}…` : 'Cutting clips…',
}[progress.stage] ?? 'Working…');

const describeMerge = (reason) => ({
  'not-adjacent': 'Those sentences are not next to each other. Merging joins a run, so pick sentences that follow one another.',
  'no-session': 'There is nothing on screen to merge.',
  superseded: 'The session changed while that was running. Nothing was merged -- try again.',
  refused: 'Nothing was merged.',
}[reason] ?? reason);

const describeImport = (reason) => ({
  'no-credentials': 'Importing audio needs your Azure key and region. Add them in Settings.',
  'no-resource-name': 'Importing audio also needs the Azure resource name, in Settings.',
  'no-speech': 'No speech was found in that file.',
}[reason] ?? reason);
