// One sentence's text, with a clickable marker at every position it can be cut.
//
// The markers come from model/geometry.js: a real word boundary where the
// sentence has timings, a confirmed seam where it was merged, and otherwise
// positions derived from the text itself. All three are offered the same way,
// and the difference that matters -- whether the position has a timestamp --
// travels as a number or null, never as a number that happens to be zero.
//
// That distinction is the reason this module exists rather than the row
// building its own text: a marker's timestamp is read back out of the DOM when
// it is clicked, and an empty attribute read with Number() is 0, which the
// audio arithmetic downstream accepts as "the very start of the file" and
// silently turns into empty clips.

import { splitPointers, chars } from '../../../model/geometry.js';
import { el, button, readNumber, writeNumber } from '../../dom.js';

/** What a masked sentence shows instead of its text. */
const MASK_CHAR = '•';

/**
 * @param {object} sentence
 * @param {object} handlers
 * @param {(charIndex: number, ms: number|null) => void} handlers.onSplit
 * @returns {Element}
 */
export function renderSentenceText(sentence, { onSplit }) {
  const wrap = el('div', { class: 'sentence-text' });

  if (sentence.hidden) {
    // Masked for practice: the point is to read from the audio, so neither the
    // text nor its cut positions are shown. Length is preserved, since how long
    // the sentence is is part of what is being practised.
    wrap.classList.add('is-hidden-text');
    wrap.append(el('span', { class: 'sentence-mask', text: MASK_CHAR.repeat(chars(sentence.text).length) }));
    return wrap;
  }

  const cs = chars(sentence.text);
  const pointers = splitPointers(sentence);
  let cursor = 0;

  for (const pointer of pointers) {
    if (pointer.charIndex > cursor) {
      wrap.append(el('span', { class: 'sentence-chunk', text: cs.slice(cursor, pointer.charIndex).join('') }));
    }
    wrap.append(splitMarker(pointer, onSplit));
    cursor = pointer.charIndex;
  }
  if (cursor < cs.length) {
    wrap.append(el('span', { class: 'sentence-chunk', text: cs.slice(cursor).join('') }));
  }

  return wrap;
}

function splitMarker(pointer, onSplit) {
  // The marker floats above the character gap rather than sitting in it: it is
  // wrapped in a zero-size inline anchor and positioned out of flow from there,
  // so it costs the line no width. An inline marker would shove the following
  // characters apart and change where the line wraps -- badly so in Japanese,
  // where a text-derived position exists between every pair of characters.
  //
  // The glyph is decoration and comes from CSS; `aria-label` is what the button
  // is called.
  const marker = button({
    class: `split-marker split-marker--${pointer.kind}`,
    title: pointer.ms == null ? 'Split here (no audio timing at this position)' : 'Split here',
    'aria-label': 'Split here',
  });
  marker.dataset.charIndex = String(pointer.charIndex);
  // null becomes an empty attribute, and readNumber gives null back. Writing
  // "0" here for a position with no timing is the bug this pair exists to
  // prevent.
  writeNumber(marker, 'ms', pointer.ms);

  marker.addEventListener('click', () => {
    onSplit(Number(marker.dataset.charIndex), readNumber(marker, 'ms'));
  });
  return el('span', { class: 'split-anchor' }, [marker]);
}

/** The positions a rendered sentence is offering, for a test or a caller that needs to know. */
export function markersOf(element) {
  return [...element.querySelectorAll('.split-marker')].map((marker) => ({
    charIndex: Number(marker.dataset.charIndex),
    ms: readNumber(marker, 'ms'),
  }));
}
