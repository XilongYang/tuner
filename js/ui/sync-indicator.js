// The header's sync indicator: a dot, one word, and the detail on hover.
//
// Sync is the one thing in this app that happens without being asked for, so
// it needs somewhere to be visible that is not a message that has already
// scrolled past. A dot is enough: green and it is done, amber and pulsing and
// it is working, red and something needs looking at -- and the words for each
// are in ./sync-text.js, shared with the settings panel so the same round is
// not described twice in two voices.
//
// It renders a state and decides nothing. Which state a round is in is app/'s
// business (main.js drives it from the one place every round goes through),
// which is also why the detail arrives as text rather than as an outcome.

import { el } from './dom.js';
import { SYNC_LABELS, syncTooltip } from './sync-text.js';

/**
 * @typedef {object} SyncIndicatorState
 * @property {'off'|'syncing'|'synced'|'failed'} state  'off' hides it entirely.
 * @property {string} [detail]  The full account, shown on hover.
 * @property {number} [at]      When a finished round finished.
 */

/**
 * @param {HTMLElement} root
 * @returns {{ set: (state: SyncIndicatorState) => void }}
 */
export function createSyncIndicator(root) {
  const dot = el('span', { class: 'sync-dot', 'aria-hidden': 'true' });
  const label = el('span', { class: 'sync-label' });
  // role=status so the word is announced when it changes, and tabindex so the
  // detail is reachable without a pointer -- the tooltip opens on focus as
  // well as hover, which is the only way to read it on a touch screen.
  const tooltip = el('div', { class: 'sync-tooltip', role: 'status' });
  root.replaceChildren(dot, label, tooltip);
  root.tabIndex = 0;

  return {
    set({ state, detail = '', at = null }) {
      // Never configured, or nothing to sync with: the header says nothing at
      // all rather than showing a grey dot that invites a question.
      root.hidden = state === 'off';
      if (root.hidden) {
        delete root.dataset.state;
        label.textContent = '';
        tooltip.textContent = '';
        return;
      }

      root.dataset.state = state;
      label.textContent = SYNC_LABELS[state] ?? '';
      tooltip.textContent = syncTooltip({ state, detail, at });
      // The tooltip is the accessible name of the thing: what the dot means is
      // in there, and the one word beside it is a summary of it.
      root.setAttribute('aria-label', `${label.textContent}. ${tooltip.textContent}`);
    },
  };
}
