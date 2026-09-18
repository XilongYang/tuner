// "记录生词" floating word-picker: a modal (same backdrop+card pattern as
// history-panel/move-picker.js) that shows one sentence's text broken into
// clickable word units, lets the user toggle any number of them on, groups
// adjacent selections into single vocab entries (non-adjacent ones become
// separate entries), and on confirm resolves each group's standalone audio
// (vocab-audio.js) and writes it to the vocab store (store/vocab.js).
//
// The pure word-segmentation/grouping logic lives in vocab-picker-geometry.js
// (no DOM, no store, no state.js -- unit-testable directly in Node, same
// split as split-geometry.js/split-render.js); this file is the DOM/store
// side that actually builds and drives the popup.

import { currentSessionId } from '../state.js';
import * as store from '../store/index.js';
import { resolveVocabAudio } from './vocab-audio.js';
import { wordUnitsForSentence, groupContiguousSelection } from './vocab-picker-geometry.js';

/**
 * Show the "记录生词" picker for `sentence`. Resolves to the number of vocab
 * entries recorded once the user confirms (0 if they selected nothing and
 * still clicked Confirm), or `undefined` if they cancelled/closed it.
 */
export function showVocabPicker(sentence) {
  return new Promise((resolve) => {
    const units = wordUnitsForSentence(sentence);
    const chars = Array.from(sentence.text);
    const selected = new Set();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target !== backdrop) return;
      backdrop.remove();
      finish(undefined);
    });

    const card = document.createElement('div');
    card.className = 'modal-card vocab-picker-card';

    const h = document.createElement('h3');
    h.textContent = 'Add vocab';
    card.appendChild(h);

    const hint = document.createElement('p');
    hint.className = 'modal-message';
    hint.textContent = 'Click one or more words; adjacent words merge into a single entry. Click "Confirm" to add them to the vocab library.';
    card.appendChild(hint);

    // Once a Confirm attempt has started, the selection is frozen (see
    // succeededGroupCount below) -- otherwise a user who changes their
    // selection in between a failed attempt and a retry would desync
    // succeededGroupCount from what groupContiguousSelection() now produces,
    // re-introducing the exact duplicate/skip risk that guard exists to
    // prevent.
    let selectionFrozen = false;
    const wordsWrap = document.createElement('div');
    wordsWrap.className = 'vocab-picker-words';
    units.forEach((unit, i) => {
      const span = document.createElement('span');
      span.className = 'vocab-picker-word';
      span.textContent = chars.slice(unit.charStart, unit.charEnd).join('');
      span.dataset.index = String(i);
      span.addEventListener('click', () => {
        if (selectionFrozen) return;
        if (selected.has(i)) {
          selected.delete(i);
          span.classList.remove('is-selected');
        } else {
          selected.add(i);
          span.classList.add('is-selected');
        }
        confirmBtn.disabled = false;
      });
      wordsWrap.appendChild(span);
    });
    card.appendChild(wordsWrap);

    const status = document.createElement('p');
    status.className = 'modal-message vocab-picker-status';
    status.hidden = true;
    card.appendChild(status);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      backdrop.remove();
      finish(undefined);
    });
    actions.appendChild(cancelBtn);

    // How many of the CURRENT selection's groups have already been written
    // to the vocab store by a previous (failed partway through) Confirm
    // click. `addVocabOccurrence()` has no idempotency check of its own --
    // it always appends a fresh occurrence -- so simply re-running the whole
    // loop on retry would duplicate every group that already succeeded
    // before the failure. groupContiguousSelection() is a pure function of
    // `selected`/`units`, both untouched between clicks (the word spans are
    // disabled to further clicks once Confirm is first pressed, see below),
    // so re-deriving `groups` on retry reliably reproduces the same list in
    // the same order, making "resume from where it failed" safe.
    let succeededGroupCount = 0;
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn primary';
    confirmBtn.type = 'button';
    confirmBtn.textContent = 'Confirm';
    confirmBtn.addEventListener('click', async () => {
      const groups = groupContiguousSelection(selected, units);
      if (!groups.length) { backdrop.remove(); finish(0); return; }
      selectionFrozen = true;
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      status.hidden = false;
      status.textContent = succeededGroupCount ? `Recording… (resuming after ${succeededGroupCount} already added)` : 'Recording…';
      try {
        for (let i = succeededGroupCount; i < groups.length; i++) {
          const group = groups[i];
          const resolved = await resolveVocabAudio(sentence, group);
          const first = group[0];
          const last = group[group.length - 1];
          const text = resolved ? resolved.text : chars.slice(first.charStart, last.charEnd).join('');
          await store.addVocabOccurrence(text, sentence.lang, {
            sessionId: currentSessionId,
            sentenceId: sentence.id,
            sentenceTextSnapshot: sentence.text,
            audioBlob: resolved ? resolved.blob : null,
          });
          succeededGroupCount = i + 1;
        }
        backdrop.remove();
        finish(groups.length);
      } catch (err) {
        console.warn('Recording vocab occurrence failed:', err);
        status.textContent = 'Failed to add vocab: ' + err.message;
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    });
    // Nothing selected yet -- Confirm starts disabled, same as "select
    // something before you can act" elsewhere in this app (e.g. Merge).
    confirmBtn.disabled = true;
    actions.appendChild(confirmBtn);

    card.appendChild(actions);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
  });
}
