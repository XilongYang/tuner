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
import { derivedInputText } from '../../../model/session.js';

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

    input.readOnly = locked;
    input.classList.toggle('is-locked', locked);
    splitBtn.textContent = locked ? 'New session' : 'Split';
    importBtn.hidden = locked;
    count.textContent = sentences.length ? `${sentences.length} sentence${sentences.length === 1 ? '' : 's'}` : '';

    reconcile(list, sentences, {
      key: (sentence) => sentence.id,
      create: (sentence) => {
        const row = createRow({ sentence, actions, player, recorderFor });
        rows.set(sentence.id, row);
        return row.element;
      },
      update: (_element, sentence) => rows.get(sentence.id)?.update(sentence),
    });

    const liveIds = new Set(sentences.map((s) => s.id));
    for (const id of [...rows.keys()]) if (!liveIds.has(id)) rows.delete(id);
    pruneRecorders(liveIds);
  }

  container.append(
    el('div', { class: 'practice-input-area' }, [input, el('div', { class: 'practice-controls' }, [splitBtn, importBtn, count]), status, fileInput]),
    list,
  );

  const unsubscribe = store.subscribe((session) => render(session));
  render(store.get());

  return {
    /** Release everything this panel holds. Called when the session on screen is replaced. */
    release() {
      for (const recorder of recorders.values()) recorder.dispose();
      recorders.clear();
    },
    say,
    destroy() {
      unsubscribe();
      this.release();
    },
  };
}

const progressText = (progress) => ({
  transcribing: 'Transcribing the audio…',
  segmenting: 'Splitting it into sentences…',
  decoding: 'Decoding the file…',
  cutting: progress.total ? `Cutting clips ${progress.done ?? 0} / ${progress.total}…` : 'Cutting clips…',
}[progress.stage] ?? 'Working…');

const describeImport = (reason) => ({
  'no-credentials': 'Importing audio needs your Azure key and region. Add them in Settings.',
  'no-resource-name': 'Importing audio also needs the Azure resource name, in Settings.',
  'no-speech': 'No speech was found in that file.',
}[reason] ?? reason);
