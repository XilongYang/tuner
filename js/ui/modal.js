// One modal primitive: a backdrop, a card, and actions.
//
// One, because the previous implementation had three hand-rolled ones that had
// already drifted apart -- on who removes the backdrop, on what gets focus, and
// on whether Escape closes. The result was that Escape dismissed a context menu
// but not the dialog asking whether to delete everything.
//
// Every modal here: closes on Escape and on a backdrop click, moves focus in on
// open and back where it was on close, and removes itself exactly once no
// matter which of those happened.

import { el, button } from './dom.js';

/**
 * Open a modal.
 *
 * @param {object} spec
 * @param {string} spec.title
 * @param {Node|string} spec.body
 * @param {Array<{label: string, value: any, primary?: boolean, danger?: boolean, autofocus?: boolean}>} spec.actions
 * @param {any} [spec.dismissValue] What closing without choosing resolves to.
 * @param {Element} [spec.mount]
 * @returns {{ result: Promise<any>, close: (value?: any) => void, card: Element }}
 */
export function openModal({ title, body, actions = [], dismissValue = undefined, mount = document.body }) {
  const previouslyFocused = document.activeElement;
  let settle;
  let settled = false;

  const result = new Promise((resolve) => { settle = resolve; });

  const backdrop = el('div', { class: 'modal-backdrop' });
  const card = el('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });

  function close(value = dismissValue) {
    // Guarded rather than trusted: backdrop click, Escape and an action button
    // can all arrive, and a second removal would throw while the first result
    // is already out.
    if (settled) return;
    settled = true;
    document.removeEventListener('keydown', onKeydown, true);
    backdrop.remove();
    previouslyFocused?.focus?.();
    settle(value);
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }

  card.append(el('h3', { class: 'modal-title', text: title }));
  card.append(typeof body === 'string' ? el('p', { class: 'modal-body', text: body }) : body);

  const row = el('div', { class: 'modal-actions' });
  let toFocus = null;
  for (const action of actions) {
    const btn = button({
      text: action.label,
      class: `btn${action.primary ? ' primary' : ''}${action.danger ? ' danger' : ''}`,
      onClick: () => close(action.value),
    });
    if (action.autofocus) toFocus = btn;
    row.append(btn);
  }
  card.append(row);

  backdrop.addEventListener('click', (event) => {
    // Only the backdrop itself: a click that started inside the card and ended
    // on it would otherwise dismiss the dialog mid-interaction.
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKeydown, true);

  backdrop.append(card);
  mount.append(backdrop);

  // Focus goes to the safest action unless told otherwise, so a stray Enter
  // cannot confirm something destructive.
  (toFocus ?? row.firstElementChild ?? card).focus?.();

  return { result, close, card };
}

/**
 * Ask a yes/no question.
 *
 * `danger` marks the confirming action, and moves the initial focus to Cancel:
 * a destructive dialog should never be one keypress from doing the thing.
 */
export function confirmModal({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  return openModal({
    title,
    body: message,
    dismissValue: false,
    actions: [
      { label: cancelLabel, value: false, autofocus: danger },
      { label: confirmLabel, value: true, primary: !danger, danger, autofocus: !danger },
    ],
  }).result;
}

/** Ask for a line of text. Resolves to the text, or null if dismissed. */
export function promptModal({ title, label, value = '', confirmLabel = 'Save' }) {
  const input = el('input', { class: 'modal-input', type: 'text', value, 'aria-label': label });
  const body = el('div', { class: 'modal-body' }, [el('label', { class: 'modal-label', text: label }), input]);

  const modal = openModal({
    title,
    body,
    dismissValue: null,
    actions: [
      { label: 'Cancel', value: null },
      { label: confirmLabel, value: true, primary: true },
    ],
  });

  // Enter submits, which is what a single-field dialog is expected to do.
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      modal.close(true);
    }
  });
  input.focus();
  input.select?.();

  return modal.result.then((confirmed) => (confirmed ? input.value : null));
}
