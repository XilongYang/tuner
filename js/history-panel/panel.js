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
export function initHistoryPanel() {
  els.toggleHistoryPanel.addEventListener('click', () => {
    if (historyPanelOpen) closeHistorySidebar();
    else openHistorySidebar();
  });
  els.historyCloseBtn.addEventListener('click', closeHistorySidebar);

  els.newFolderBtn.addEventListener('click', () => promptCreateFolder(null));

  els.clearHistoryBtn.addEventListener('click', async () => {
    if (!confirm('Delete all saved practice history and folders from this browser? This cannot be undone.')) return;
    els.clearHistoryBtn.disabled = true;
    try {
      await store.clearAll();
      setCurrentSessionId(null);
      await renderHistoryTree();
    } catch (err) {
      alert('Failed to clear history: ' + err.message);
    } finally {
      els.clearHistoryBtn.disabled = false;
    }
  });
}
