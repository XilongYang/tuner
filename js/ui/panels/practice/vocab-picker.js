// Picking words out of a sentence to add to the vocabulary library.
//
// The sentence, broken into its word units, each one clickable. Any number can
// be on at once, and the ones that touch in the word sequence become a single
// entry while the ones that do not become separate entries -- so "picked a
// phrase" and "picked two words" are the same gesture, told apart by where the
// words were.
//
// The grouping itself is model/geometry.js's. What counts as a word is not a
// question this asks: the sentence's word spans came from the service that read
// it, and they are what the picked clip is cut against.

import { openModal } from '../../modal.js';
import { el, button } from '../../dom.js';
import { chars, groupAdjacent } from '../../../model/geometry.js';

const phrase = (text, units) => text.slice(units[0].charStart, units[units.length - 1].charEnd);

/**
 * The words of the sentence that no unit covers.
 *
 * A reading's own tokens are what the units are, and a token the reading
 * reported but could not be placed in the text is dropped (see
 * model/transcript.js). When that happens the picker offers fewer words than
 * the sentence has, and saying nothing about it makes the missing ones look
 * like a bug in the sentence rather than a gap in the reading.
 */
export function unplaced(text, units) {
  const covered = new Array(text.length).fill(false);
  for (const unit of units) {
    for (let i = unit.charStart; i < unit.charEnd; i += 1) covered[i] = true;
  }
  return [...text].map((ch, i) => (covered[i] ? ' ' : ch)).join('')
    .split(/\s+/u)
    .filter(Boolean);
}

/** What the selection will produce, said before it is produced. */
export function describeSelection(text, units, selected) {
  const groups = groupAdjacent(selected);
  if (!groups.length) return 'Click the words you want to keep.';

  const phrases = groups.map((group) => `“${phrase(text, group.map((i) => units[i]))}”`);
  if (phrases.length === 1) return `One entry: ${phrases[0]}`;
  return `${phrases.length} entries: ${phrases.join(', ')} — words that touch become one entry, words that do not become separate ones.`;
}

/**
 * Open the picker for one sentence.
 *
 * @param {object} spec
 * @param {object} spec.sentence
 * @param {(groups: object[][]) => Promise<{ok: boolean, added: number, reason: string|null}>} spec.addGroups
 * @returns {Promise<{added: number}|null>} null when dismissed without adding.
 */
export function vocabPicker({ sentence, addGroups }) {
  // The sentence's own word spans, and only those: each one is a position in
  // real audio, which is what a vocabulary entry's clip is cut from. A row
  // only offers this once they exist (see row.js).
  const units = sentence.words || [];
  const text = sentence.text || '';
  const selected = new Set();

  const hint = el('p', { class: 'modal-message', text: describeSelection(text, units, selected) });

  const missing = unplaced(text, units);
  const gap = missing.length
    ? el('p', {
      class: 'modal-message vocab-unplaced',
      text: `The reading did not place ${missing.length === 1 ? 'one word' : `${missing.length} words`} of this sentence (${missing.join(', ')}), so ${missing.length === 1 ? 'it is' : 'they are'} not offered here. Speaking the sentence again may place ${missing.length === 1 ? 'it' : 'them'}.`,
    })
    : null;
  const status = el('p', { class: 'modal-message vocab-status', hidden: true });
  const words = el('div', { class: 'vocab-words' });

  // Frozen once a first Confirm has been attempted. The count of groups
  // already written is what makes a retry safe, and it only means anything
  // while the groups it was counted against cannot change.
  let frozen = false;
  let added = 0;

  const chips = units.map((unit, index) => {
    const chip = button({
      class: 'vocab-word',
      text: chars(text).slice(unit.charStart, unit.charEnd).join(''),
      onClick: () => {
        if (frozen) return;
        if (selected.has(index)) selected.delete(index);
        else selected.add(index);
        chip.classList.toggle('is-selected', selected.has(index));
        chip.setAttribute('aria-pressed', String(selected.has(index)));
        hint.textContent = describeSelection(text, units, selected);
        confirm.disabled = selected.size === 0;
      },
    });
    chip.setAttribute('aria-pressed', 'false');
    return chip;
  });
  words.append(...chips);

  const body = el('div', { class: 'vocab-picker' }, [hint, words, gap, status].filter(Boolean));

  let modal;
  const confirm = button({
    class: 'btn primary', text: 'Add', disabled: true,
    onClick: async () => {
      const groups = groupAdjacent(selected).map((group) => group.map((i) => units[i]));
      frozen = true;
      confirm.disabled = true;
      status.hidden = false;
      status.dataset.kind = 'busy';
      status.textContent = added
        ? `Adding… (${added} of ${groups.length} already went in)`
        : 'Adding…';

      // Only what has not gone in yet. Re-sending the successful groups would
      // not duplicate them -- an occurrence is keyed by where it came from --
      // but it would re-cut and re-upload their audio for nothing.
      const outcome = await addGroups(groups.slice(added));
      added += outcome.added;
      if (outcome.ok) {
        modal.close({ added });
        return;
      }

      status.dataset.kind = 'error';
      status.textContent = `${describeFailure(outcome.reason)} ${added} of ${groups.length} went in; pressing Add again continues from there.`;
      confirm.disabled = false;
    },
  });

  modal = openModal({
    title: 'Add vocab',
    body,
    actions: [{ label: 'Cancel', value: null }],
    dismissValue: null,
  });
  // The Add button does its work in place rather than closing the modal, so it
  // is not one of openModal's actions -- those resolve and close.
  modal.card.querySelector('.modal-actions').append(confirm);

  return modal.result;
}

function describeFailure(reason) {
  if (reason === 'gone') return 'That sentence is no longer there.';
  if (reason === 'not-a-word') return 'There is nothing to record in that selection.';
  if (reason === 'no-selection') return 'Nothing was selected.';
  return `Could not add it: ${reason}.`;
}
