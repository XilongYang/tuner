// Folder/session actions offered from the context menu: create, rename,
// delete, and the "Move to..." picker modal.

import * as store from '../store/index.js';
import { setCurrentSessionId, currentSessionId } from '../state.js';
import { scheduleAutoSync } from '../sync/index.js';
import { renderHistoryTree } from './panel.js';
import { expandedFolders, collectDescendantFolderIds, sessionDisplayName } from './tree.js';

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
    if (session.id === currentSessionId) setCurrentSessionId(null);
    await renderHistoryTree();
    scheduleAutoSync();
  } catch (err) {
    alert('Failed to delete session: ' + err.message);
  }
}

/** "Move to…" modal: pick a destination folder (or root) from the full folder tree. */
export async function openMovePicker({ kind, item }) {
  const [folders, sessions] = await Promise.all([store.listFolders(), store.listSessions()]);

  const excludeIds = new Set();
  if (kind === 'folder') {
    excludeIds.add(item.id);
    collectDescendantFolderIds(item.id, folders).forEach((id) => excludeIds.add(id));
  }

  let selected = kind === 'folder' ? (item.parentId ?? null) : (item.folderId ?? null);

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });

  const card = document.createElement('div');
  card.className = 'modal-card';

  const h = document.createElement('h3');
  h.textContent = kind === 'folder' ? `Move "${item.name}" to…` : `Move "${sessionDisplayName(item)}" to…`;
  card.appendChild(h);

  const treeWrap = document.createElement('div');
  treeWrap.className = 'modal-tree';

  const rootRow = document.createElement('div');
  rootRow.className = 'modal-tree-row';
  rootRow.textContent = '(Root — no folder)';
  rootRow.addEventListener('click', () => select(null));
  treeWrap.appendChild(rootRow);

  function renderPickerLevel(parentId, depth) {
    const childFolders = folders
      .filter((f) => (f.parentId ?? null) === parentId && !excludeIds.has(f.id))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    for (const f of childFolders) {
      const row = document.createElement('div');
      row.className = 'modal-tree-row';
      row.style.paddingLeft = `${8 + depth * 16}px`;
      row.textContent = f.name || 'Untitled folder';
      row.dataset.folderId = String(f.id);
      row.addEventListener('click', () => select(f.id));
      treeWrap.appendChild(row);
      renderPickerLevel(f.id, depth + 1);
    }
  }
  renderPickerLevel(null, 0);

  function select(id) {
    selected = id;
    rootRow.classList.toggle('is-selected', selected === null);
    treeWrap.querySelectorAll('[data-folder-id]').forEach((el) => {
      el.classList.toggle('is-selected', Number(el.dataset.folderId) === selected);
    });
  }
  select(selected);

  card.appendChild(treeWrap);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => backdrop.remove());
  actions.appendChild(cancelBtn);

  const moveBtn = document.createElement('button');
  moveBtn.className = 'btn primary';
  moveBtn.type = 'button';
  moveBtn.textContent = 'Move';
  moveBtn.addEventListener('click', async () => {
    moveBtn.disabled = true;
    try {
      if (kind === 'folder') await store.moveFolder(item.id, selected);
      else await store.moveSessionToFolder(item.id, selected);
      backdrop.remove();
      await renderHistoryTree();
      scheduleAutoSync();
    } catch (err) {
      moveBtn.disabled = false;
      alert('Failed to move: ' + err.message);
    }
  });
  actions.appendChild(moveBtn);

  card.appendChild(actions);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
}