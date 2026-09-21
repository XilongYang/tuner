// The one line a panel uses to say how something went.
//
// It had no lifetime at all: `say` set the text, and nothing ever cleared it.
// "Session deleted." then sat above the list of sessions for the rest of the
// page's life, and worse, it came back with the panel -- reopening the library
// an hour later showed an announcement about a deletion as though it had just
// happened, next to a list that no longer had anything to do with it.
//
// What the line says decides how long it should last:
//
//   info   an acknowledgement of a gesture just made ("Session deleted.").
//          True only in relation to that gesture, so it goes on its own.
//   busy   a thing still happening. Stays until its own outcome replaces it --
//          a spinner that times out is a lie.
//   error  something went wrong, and the reader may not have been looking.
//          Stays until the next action says something else.
//
// Closing the panel clears it whatever it says: the next time it opens is a
// new visit, and a stale line at the top of it is read as current.

import { el } from './dom.js';

/** How long an acknowledgement stays up. Long enough to be read twice. */
export const INFO_MS = 5000;

/**
 * @param {object} [opts]
 * @param {(fn: () => void, ms: number) => any} [opts.setTimer] Injected by
 *   tests so they do not have to wait five seconds to see the line go.
 * @param {(handle: any) => void} [opts.clearTimer]
 * @returns {{node: HTMLElement, say: (message: string, kind?: string) => void, clear: () => void}}
 */
export function panelStatus({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const node = el('p', { class: 'panel-status', hidden: true });
  let timer = null;

  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const show = (message, kind) => {
    node.hidden = !message;
    node.textContent = message || '';
    node.dataset.kind = kind;
  };

  const clear = () => {
    stopTimer();
    show('', 'info');
  };

  return {
    node,
    say(message, kind = 'info') {
      // Every call owns the line from here: a pending expiry belongs to the
      // message it was started for, and leaving it running would take the new
      // one down early.
      stopTimer();
      show(message, kind);
      if (message && kind === 'info') timer = setTimer(() => { timer = null; show('', kind); }, INFO_MS);
    },
    clear,
  };
}
