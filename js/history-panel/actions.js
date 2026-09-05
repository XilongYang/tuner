// Folder/session actions offered from the context menu: create, rename,
// delete, move (both the "Move to..." menu item and tree.js's drag-and-drop
// use moveItem() below), plus the toolbar's Export/Import/Clear-all backup
// actions (extracted from panel.js's initHistoryPanel(), which now only
// binds these as one-line click/change listeners).
//
// Circular with tree.js (moveItem() here is tree.js's drop handler's only
// way to do a move now, while this file still imports tree.js's
// collectDescendantFolderIds/expandedFolders/sessionDisplayName) -- safe,
// same as the rest of this codebase's sentence-panel/history-panel cycles:
// both sides only call into each other from inside functions, never at
// module-evaluation time.

import * as store from '../store/index.js';
import { els, currentSessionId, setCurrentSessionId } from '../state.js';
import { scheduleAutoSync } from '../sync/index.js';
import { startNewSession } from '../sentence-panel/index.js';
import { downloadBlob } from '../sentence-panel/export-utils.js';
import { openConfirmModal, paintHistoryTree } from './panel.js';
import { expandedFolders, collectDescendantFolderIds, sessionDisplayName } from './tree.js';
import { showMovePicker } from './move-picker.js';

// Bumped at the start of every renderHistoryTree() call; a call only paints
// if its own token is still the latest one when its awaited store read comes
// back. Without this, two overlapping calls (e.g. opening the History panel
// right as a sync's refreshHistoryTreeIfOpen() also fires) could paint out of
// order and leave the tree rendered twice.
let historyRenderToken = 0;

/**
 * Fetch the current folders/sessions from store and repaint the tree
 * (panel.js's paintHistoryTree(), which never touches store itself) -- the
 * one function in this domain that both reads store and triggers a DOM
 * update; every other store-touching action below just calls this
 * afterward to refresh the sidebar.
 */
export async function renderHistoryTree() {
  const token = ++historyRenderToken;

  if (!store.isSupported()) {
    if (token !== historyRenderToken) return; // superseded while this call was in flight
    paintHistoryTree({ supported: false });
    return;
  }

  let folders, sessions;
  try {
    [folders, sessions] = await Promise.all([store.listFolders(), store.listSessions()]);
  } catch (err) {
    if (token !== historyRenderToken) return;
    paintHistoryTree({ supported: true, error: err });
    return;
  }
  if (token !== historyRenderToken) return; // a newer call already owns the DOM from here on

  paintHistoryTree({ supported: true, folders, sessions });
}

// ---- Folder / session actions ----

export async function promptCreateFolder(parentId) {
  const name = prompt('Folder name:', '');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    await store.createFolder({ name: trimmed, parentId: parentId ?? null });
    if (parentId != null) expandedFolders.add(parentId);
    await renderHistoryTree();
    scheduleAutoSync();
  } catch (err) {
    alert('Failed to create folder: ' + err.message);
  }
}

export async function startRenameFolder(folder) {
  const name = prompt('Rename folder:', folder.name || '');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === folder.name) return;
  try {
    await store.renameFolder(folder.id, trimmed);
    await renderHistoryTree();
    scheduleAutoSync();
  } catch (err) {
    alert('Failed to rename folder: ' + err.message);
  }
}

export async function startRenameSession(session) {
  const name = prompt('Rename session:', session.name || sessionDisplayName(session));
  if (name === null) return;
  try {
    await store.renameSession(session.id, name.trim());
    await renderHistoryTree();
    scheduleAutoSync();
  } catch (err) {
    alert('Failed to rename session: ' + err.message);
  }
}

export async function confirmDeleteFolder(folder) {
  if (!confirm(`Delete folder "${folder.name}"? Sessions and subfolders inside it will move up one level, not be deleted.`)) return;
  try {
    await store.deleteFolder(folder.id);
    expandedFolders.delete(folder.id);
    await renderHistoryTree();
    scheduleAutoSync();
  } catch (err) {
    alert('Failed to delete folder: ' + err.message);
  }
}

export async function confirmDeleteSession(session) {
  if (!confirm('Delete this saved session? This cannot be undone.')) return;
  try {
    await store.deleteSession(session.id);
    // Deleting the session currently on screen would otherwise leave its
    // stale sentences/input showing under a now-dangling session id.
    if (session.id === currentSessionId) startNewSession();
    await renderHistoryTree();
    scheduleAutoSync();
  } catch (err) {
    alert('Failed to delete session: ' + err.message);
  }
}

/**
 * Move a folder or session (`payload` is `{ kind: 'folder'|'session', id }`,
 * the same shape tree.js's drag-and-drop already carries as its drop
 * payload) to `targetFolderId` (null = root). The one store-mutating action
 * shared by both ways of moving something -- the "Move to…" menu item
 * (openMovePicker below) and tree.js's makeDropTarget() drop handler -- so
 * the cycle-detection logic (a folder can't be dropped into its own
 * descendant) only exists once.
 */
export async function moveItem(payload, targetFolderId) {
  if (payload.kind === 'folder') {
    if (payload.id === targetFolderId) return; // dropped on itself
    const folders = await store.listFolders();
    const descendants = collectDescendantFolderIds(payload.id, folders);
    if (targetFolderId != null && descendants.includes(targetFolderId)) return; // would create a cycle
    await store.moveFolder(payload.id, targetFolderId);
  } else if (payload.kind === 'session') {
    await store.moveSessionToFolder(payload.id, targetFolderId);
  } else {
    return;
  }
  if (targetFolderId != null) expandedFolders.add(targetFolderId);
  await renderHistoryTree();
  scheduleAutoSync();
}

/** "Move to…" modal: pick a destination folder (or root) from the full
 *  folder tree (move-picker.js's showMovePicker(), which only presents the
 *  choice) then actually perform it (moveItem() above). */
export async function openMovePicker({ kind, item }) {
  const folders = await store.listFolders();
  const selected = await showMovePicker({ kind, item, folders });
  if (selected === undefined) return; // cancelled
  try {
    await moveItem({ kind, id: item.id }, selected);
  } catch (err) {
    alert('Failed to move: ' + err.message);
  }
}

// ---- Toolbar backup actions (Export / Import / Clear all) ----

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

export async function exportHistory() {
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
}

export async function importHistory(file) {
  if (!file) return;

  // A full import REPLACES all local history, same destructive shape as
  // "Restore from Azure" (sync/azure-sync.js) -- one clear confirmation,
  // matching that feature's own single confirm() rather than Clear all's
  // two-step/countdown treatment below (this is a deliberate, well-labeled
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
}

export async function clearAllHistory() {
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
    // confirmDeleteSession() above.
    startNewSession();
    await renderHistoryTree();
    scheduleAutoSync();
  } catch (err) {
    alert('Failed to clear history: ' + err.message);
  } finally {
    els.clearHistoryBtn.disabled = false;
  }
}
