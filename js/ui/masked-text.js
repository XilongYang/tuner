// Text that can be hidden without being taken away.
//
// Practising from memory means seeing that something is there and not what it
// is: the characters keep their places and their count, and a dot is drawn over
// each of them. That is a different thing from removing the text, and the
// difference matters -- the shape of the sentence is a cue, and a reader has to
// be able to tell "hidden" from "empty".
//
// The practice column has its own version of this, because its characters also
// carry the cut markers and the reading highlight. This is for text that only
// needs hiding.

import { el } from './dom.js';

/**
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.hidden]
 * @param {string} [opts.class]
 * @param {() => void} [opts.onReveal] Makes the text clickable: hidden text is
 *   worth nothing if there is no way to check the answer.
 */
export function maskedText(text, { hidden = false, class: className = '', onReveal = null } = {}) {
  const classes = ['masked-text', className].filter(Boolean).join(' ');
  if (!hidden) return el('span', { class: classes, text });

  const host = el('span', {
    class: `${classes} is-masked`,
    // The text is deliberately not in the accessible name either: a screen
    // reader announcing it would be the same as printing it.
    'aria-label': `${[...text].length} hidden characters`,
    // A button only when there is something to press. Announcing one that does
    // nothing is worse than announcing nothing: it is an invitation to press a
    // thing that will not answer.
    role: onReveal ? 'button' : null,
    tabIndex: onReveal ? 0 : -1,
    title: onReveal ? 'Click to reveal' : null,
  });
  // One span per character, so the run of dots is the length of the word
  // rather than a fixed blob. Whitespace stays whitespace: a gap between two
  // words is part of the shape.
  for (const ch of text) {
    host.append(/\s/u.test(ch) ? document.createTextNode(ch) : el('span', { class: 'masked-char', text: ch }));
  }

  if (onReveal) {
    host.addEventListener('click', onReveal);
    host.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onReveal();
      }
    });
  }
  return host;
}
