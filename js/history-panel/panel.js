// The History sidebar shell: open/close state, the empty-state message, and
// the render-token-guarded renderHistoryTree() (see the comment on
// historyRenderToken below for the double-render race it fixes), plus
// initHistoryPanel() wiring the toolbar buttons.

import * as store from '../store/index.js';
import { els, setCurrentSessionId } from '../state.js';
import { makeDropTarget, renderTreeLevel } from './tree.js';
import { promptCreateFolder } from './actions.js';
import { closeCtxMenu } from './context-menu.js';
import { saveHistoryOpen } from '../config.js';
import { startNewSession } from '../sentence-panel/index.js';
import { scheduleAutoSync } from '../sync/index.js';
import { downloadBlob } from '../sentence-panel/export-utils.js';

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

// Bumped at the start of every renderHistoryTree() call; a call only writes
// to the DOM if its own token is still the latest one when its awaited data
// comes back. Without this, two overlapping calls (e.g. opening the History
// panel right as a sync's refreshHistoryTreeIfOpen() also fires) each clear
// `historyTree` and then append independently -- whichever call's
// Promise.all() resolves LAST wins the clear, but the one that resolves
// FIRST has already appended by then and never clears again, so its rows
// stay behind and the whole tree renders twice.
let historyRenderToken = 0;

export async function renderHistoryTree() {
  const token = ++historyRenderToken;

  if (!store.isSupported()) {
    els.historyTree.innerHTML = '';
    els.historyTree.appendChild(emptyMsg("This browser doesn't support local history (IndexedDB unavailable)."));
    return;
  }

  let folders, sessions;
  try {
    [folders, sessions] = await Promise.all([store.listFolders(), store.listSessions()]);
  } catch (err) {
    if (token !== historyRenderToken) return; // superseded while this call was in flight
    els.historyTree.innerHTML = '';
    els.historyTree.appendChild(emptyMsg('Failed to load history: ' + err.message));
    return;
  }
  if (token !== historyRenderToken) return; // a newer call already owns the DOM from here on

  els.historyTree.innerHTML = '';

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
 * the "Move to..." picker in actions.js), resolving true/false depending on
 * whether the user confirms, cancels, or clicks the backdrop (treated as
 * cancel). `countdownSeconds`, if set, keeps the confirm button disabled and
 * ticking down in its own label until it elapses, so it can't be clicked
 * through on reflex -- used for the first of Clear all's two confirmations.
 */
function openConfirmModal({ title, message, confirmLabel, danger = false, countdownSeconds = 0 }) {
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

function setHistoryIoStatus(text, kind) {
  if (!els.historyIoStatus) return;
  els.historyIoStatus.hidden = !text;
  els.historyIoStatus.textContent = text || '';
  if (kind) els.historyIoStatus.dataset.kind = kind;
  else delete els.historyIoStatus.dataset.kind;
}

/** Build today's default filename for a full-backup export, e.g.
 *  "tuner-backup-2026-09-04.tuner". */
function backupFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `tuner-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.tuner`;
}

export function initHistoryPanel() {
  els.toggleHistoryPanel.addEventListener('click', () => {
    if (historyPanelOpen) closeHistorySidebar();
    else openHistorySidebar();
  });
  els.historyCloseBtn.addEventListener('click', closeHistorySidebar);

  els.newFolderBtn.addEventListener('click', () => promptCreateFolder(null));

  els.exportHistoryBtn.addEventListener('click', async () => {
    els.exportHistoryBtn.disabled = true;
    setHistoryIoStatus('Building backup…', 'info');
    try {
      const zip = await store.buildBackupZip();
      downloadBlob(zip, backupFilename());
      setHistoryIoStatus('', null);
    } catch (err) {
      setHistoryIoStatus('Export failed: ' + err.message, 'error');
    } finally {
      els.exportHistoryBtn.disabled = false;
    }
  });

  els.importHistoryBtn.addEventListener('click', () => els.importHistoryInput.click());
  els.importHistoryInput.addEventListener('change', async () => {
    const file = els.importHistoryInput.files[0];
    els.importHistoryInput.value = ''; // let re-picking the same file re-fire change
    if (!file) return;

    // A full import REPLACES all local history, same destructive shape as
    // "Restore from Azure" (sync/azure-sync.js) -- one clear confirmation,
    // matching that feature's own single confirm() rather than Clear all's
    // two-step/countdown treatment above (this is a deliberate, well-labeled
    // file pick, not a stray click).
    if (!confirm(
      `Import "${file.name}"? This replaces ALL local practice history in this browser `
      + 'with the contents of this backup. This cannot be undone. Continue?',
    )) return;

    els.importHistoryBtn.disabled = true;
    setHistoryIoStatus('Reading backup…', 'info');
    try {
      const buffer = await file.arrayBuffer();
      const parsed = await store.parseBackupZip(buffer);
      // Without this, the imported data's own (old, as-of-export) timestamps
      // would lose the very next sync's last-write-wins merge against
      // whatever is currently on Azure, and get quietly overwritten right
      // back -- see freshenImportTimestamps()'s doc comment in store/backup.js.
      const { folders, sessions, tombstones } = store.freshenImportTimestamps(parsed);
      setHistoryIoStatus('Writing to local storage…', 'info');
      await store.restoreSnapshot({ folders, sessions, tombstones });
      setCurrentSessionId(null);
      // Whatever session was on screen may no longer exist under this id --
      // same reasoning as confirmDeleteSession()/Clear all above.
      startNewSession();
      await renderHistoryTree();
      scheduleAutoSync();
      setHistoryIoStatus(`Imported ${sessions.length} session(s), ${folders.length} folder(s).`, 'info');
    } catch (err) {
      setHistoryIoStatus('Import failed: ' + err.message, 'error');
    } finally {
      els.importHistoryBtn.disabled = false;
    }
  });

  els.clearHistoryBtn.addEventListener('click', async () => {
    // Two confirmations for a destructive, unrecoverable action -- the first
    // gated by a 3s countdown so it can't be clicked through on reflex.
    const step1 = await openConfirmModal({
      title: 'Clear all history?',
      message: 'This permanently deletes every saved session and folder on '
        + 'this device -- and, once the next sync runs, on Azure too. This cannot be undone.',
      confirmLabel: 'Continue',
      danger: true,
      countdownSeconds: 3,
    });
    if (!step1) return;

    const step2 = await openConfirmModal({
      title: 'Are you absolutely sure?',
      message: 'Last chance -- every saved session and folder will be gone for good.',
      confirmLabel: 'Delete everything',
      danger: true,
      countdownSeconds: 3,
    });
    if (!step2) return;

    els.clearHistoryBtn.disabled = true;
    try {
      await store.clearAll();
      setCurrentSessionId(null);
      // Whatever session was on screen no longer exists -- same reasoning as
      // confirmDeleteSession() in actions.js.
      startNewSession();
      await renderHistoryTree();
      scheduleAutoSync();
    } catch (err) {
      alert('Failed to clear history: ' + err.message);
    } finally {
      els.clearHistoryBtn.disabled = false;
    }
  });
}
