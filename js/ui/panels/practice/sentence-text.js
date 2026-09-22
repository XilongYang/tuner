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

/**
 * @param {object} sentence
 * @param {object} handlers
 * @param {(charIndex: number, ms: number|null) => void} handlers.onSplit
 * @returns {Element}
 */
export function renderSentenceText(sentence, { onSplit }) {
  const wrap = el('div', { class: 'sentence-text' });

  // Masked for practice: the characters are still here, still in their places,
  // and still carrying their positions -- the mask is painted over them by CSS
  // and the text itself is never altered. That is what lets the cut markers
  // stay (a sentence is often split precisely while practising it from memory)
  // and what lets a reading be followed along a sentence that is not showing.
  if (sentence.hidden) wrap.classList.add('is-hidden-text');

  const cs = chars(sentence.text);
  const pointers = splitPointers(sentence);
  const pointersAt = new Map();
  for (const pointer of pointers) {
    if (!pointersAt.has(pointer.charIndex)) pointersAt.set(pointer.charIndex, []);
    pointersAt.get(pointer.charIndex).push(pointer);
  }

  for (let i = 0; i <= cs.length; i++) {
    for (const pointer of pointersAt.get(i) || []) wrap.append(splitMarker(pointer, onSplit));
    if (i === cs.length) break;

    // Whitespace stays a plain text node: a span per space would mask the gaps
    // between words as if they were characters, and there is nothing to
    // highlight or cut inside one.
    const ch = cs[i];
    if (/\s/u.test(ch)) wrap.append(ch);
    else wrap.append(el('span', { class: 'sentence-char', text: ch, dataset: { charIndex: String(i) } }));
  }

  return wrap;
}

/**
 * Light the characters of the word currently being spoken, and nothing else.
 *
 * Called on every playback tick, so it does the least it can: the characters
 * that should be lit and are not get the class, the ones that are lit and
 * should not lose it, and the rest are left alone. `word` is null between words
 * and when playback stops, which clears the sentence.
 */
export function setSpeaking(element, word) {
  const from = word?.charStart ?? -1;
  const to = word?.charEnd ?? -1;

  for (const span of element.querySelectorAll('.sentence-char')) {
    const index = Number(span.dataset.charIndex);
    const lit = index >= from && index < to;
    span.classList.toggle('is-speaking', lit);
  }
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
