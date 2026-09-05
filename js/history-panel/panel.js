// The History sidebar shell: open/close state, the empty-state message,
// paintHistoryTree() (pure DOM -- see its own doc comment for why the store
// fetch it used to do lives in actions.js's renderHistoryTree() now), plus
// initHistoryPanel() wiring the toolbar buttons and the shared
// openConfirmModal() primitive. No store import here at all -- see
// paintHistoryTree()'s doc comment.
//
// Circular with actions.js (this file imports promptCreateFolder/
// exportHistory/importHistory/clearAllHistory/renderHistoryTree from there,
// while actions.js imports paintHistoryTree/openConfirmModal from here) --
// safe, same as the rest of this codebase's sentence-panel/history-panel
// cycles: both sides only call into each other from inside functions, never
// at module-evaluation time.

import { els } from '../state.js';
import { makeDropTarget, renderTreeLevel } from './tree.js';
import {
  promptCreateFolder, exportHistory, importHistory, clearAllHistory, renderHistoryTree,
} from './actions.js';
import { closeCtxMenu } from './context-menu.js';
import { saveHistoryOpen } from '../config.js';

let historyPanelOpen = false;

/** Re-render the tree if the sidebar is currently open (e.g. after a new session is created). */
export function refreshHistoryTreeIfOpen() {
  if (historyPanelOpen) renderHistoryTree();
}

export function openHistorySidebar() {
  historyPanelOpen = true;
  els.historySidebar.classList.add('is-open');
  els.toggleHistoryPanel.setAttribute('aria-expanded', 'true');
  saveHistoryOpen(true);
  renderHistoryTree();
}

function closeHistorySidebar() {
  historyPanelOpen = false;
  els.historySidebar.classList.remove('is-open');
  els.toggleHistoryPanel.setAttribute('aria-expanded', 'false');
  saveHistoryOpen(false);
  closeCtxMenu();
}

function emptyMsg(text) {
  const p = document.createElement('p');
  p.className = 'history-empty';
  p.textContent = text;
  return p;
}

/**
 * Paint the tree DOM from an already-fetched result -- a pure function of
 * its input, no store access. `result` is one of:
 *   { supported: false }                          -- IndexedDB unavailable
 *   { supported: true, error }                     -- the store read failed
 *   { supported: true, folders, sessions }          -- normal case
 *
 * The actual store.listFolders()/listSessions() call (plus the
 * historyRenderToken race-guard bracketing it -- overlapping calls, e.g.
 * opening the History panel right as a sync's refreshHistoryTreeIfOpen()
 * also fires, otherwise clear/append out of order and the tree renders
 * twice) lives in actions.js's renderHistoryTree() now, the domain's
 * designated sole store-importer -- this file only ever receives the
 * finished result and draws it.
 */
export function paintHistoryTree(result) {
  els.historyTree.innerHTML = '';

  if (!result.supported) {
    els.historyTree.appendChild(emptyMsg("This browser doesn't support local history (IndexedDB unavailable)."));
    return;
  }
  if (result.error) {
    els.historyTree.appendChild(emptyMsg('Failed to load history: ' + result.error.message));
    return;
  }

  const { folders, sessions } = result;
  if (!folders.length && !sessions.length) {
    els.historyTree.appendChild(emptyMsg('No saved sessions yet — click Split to start one.'));
    return;
  }

  // A standing drop target for dragging something back out to the top level.
  if (folders.length) {
    const rootDrop = document.createElement('div');
    rootDrop.className = 'tree-row tree-root-drop';
    rootDrop.textContent = 'Root — drop here to remove from folder';
    makeDropTarget(rootDrop, null);
    els.historyTree.appendChild(rootDrop);
  }

  els.historyTree.appendChild(renderTreeLevel(null, folders, sessions));
}

/**
 * A custom Cancel/Confirm modal (same .modal-backdrop/.modal-card markup as
 * the "Move to..." picker in move-picker.js), resolving true/false depending
 * on whether the user confirms, cancels, or clicks the backdrop (treated as
 * cancel). `countdownSeconds`, if set, keeps the confirm button disabled and
 * ticking down in its own label until it elapses, so it can't be clicked
 * through on reflex -- used for the first of Clear all's two confirmations.
 * Exported for actions.js's clearAllHistory(), the only caller -- it stays
 * here rather than moving there since it's a generic, zero-store modal
 * primitive, the same reasoning that keeps it separate from the toolbar
 * actions it happens to be used by.
 */
export function openConfirmModal({ title, message, confirmLabel, danger = false, countdownSeconds = 0 }) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      backdrop.remove();
      resolve(value);
    };

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(false); });

    const card = document.createElement('div');
    card.className = 'modal-card';

    const h = document.createElement('h3');
    h.textContent = title;
    card.appendChild(h);

    const p = document.createElement('p');
    p.className = 'modal-message';
    p.textContent = message;
    card.appendChild(p);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => finish(false));
    actions.appendChild(cancelBtn);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = danger ? 'btn danger primary' : 'btn primary';
    confirmBtn.type = 'button';
    confirmBtn.textContent = confirmLabel;
    confirmBtn.addEventListener('click', () => finish(true));
    actions.appendChild(confirmBtn);

    card.appendChild(actions);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    cancelBtn.focus();

    if (countdownSeconds > 0) {
      let remaining = countdownSeconds;
      confirmBtn.disabled = true;
      confirmBtn.textContent = `${confirmLabel} (${remaining})`;
      timer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(timer);
          timer = null;
          confirmBtn.disabled = false;
          confirmBtn.textContent = confirmLabel;
        } else {
          confirmBtn.textContent = `${confirmLabel} (${remaining})`;
        }
      }, 1000);
    }
  });
}

/** Wire the sidebar's toolbar buttons: open/close, new folder, and the three
 *  backup actions (their actual logic lives in actions.js's
 *  exportHistory()/importHistory()/clearAllHistory() now -- this just binds
 *  each button/input to its handler). */
export function initHistoryPanel() {
  els.toggleHistoryPanel.addEventListener('click', () => {
    if (historyPanelOpen) closeHistorySidebar();
    else openHistorySidebar();
  });
  els.historyCloseBtn.addEventListener('click', closeHistorySidebar);

  els.newFolderBtn.addEventListener('click', () => promptCreateFolder(null));

  els.exportHistoryBtn.addEventListener('click', exportHistory);

  els.importHistoryBtn.addEventListener('click', () => els.importHistoryInput.click());
  els.importHistoryInput.addEventListener('change', () => {
    const file = els.importHistoryInput.files[0];
    els.importHistoryInput.value = ''; // let re-picking the same file re-fire change
    importHistory(file);
  });

  els.clearHistoryBtn.addEventListener('click', clearAllHistory);
}
