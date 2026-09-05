// Folder/session tree rendering (folder icon, expand/collapse, counts) and
// drag-and-drop filing -- an alternative to the "Move to..." menu item.

import { els, currentSessionId, formatDate } from '../state.js';
import { openFolderMenu, openSessionMenu } from './context-menu.js';
import { openSession } from './session-open.js';
// Circular with actions.js (moveItem()/renderHistoryTree() there are this
// file's only way to move something or repaint the tree now, while
// actions.js still imports collectDescendantFolderIds/expandedFolders/
// sessionDisplayName from here) -- safe, same as the rest of this codebase's
// sentence-panel/history-panel cycles: both sides only call into each other
// from inside functions, never at module-evaluation time.
import { moveItem, renderHistoryTree } from './actions.js';

// Which folder ids are currently expanded in the tree (shared by the tree
// renderer, drag-and-drop filing, and the folder/session actions below that
// need to auto-expand a folder something was just moved/created into).
export const expandedFolders = new Set();

// ---- Drag and drop (an alternative to the "Move to…" menu item) ----

function readDragPayload(e) {
  try {
    const raw = e.dataTransfer.getData('text/plain');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Make `row` draggable, carrying `{ kind: 'folder'|'session', id }` as its drag payload. */
export function makeDraggable(row, kind, id) {
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify({ kind, id }));
    row.classList.add('is-dragging');
    // Reveal the root drop zone only while a drag is actually in progress.
    els.historyTree.classList.add('is-dragging-active');
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('is-dragging');
    els.historyTree.classList.remove('is-dragging-active');
    document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  });
}

/** Make `row` a drop target that files the dragged folder/session into `targetFolderId` (null = root). */
export function makeDropTarget(row, targetFolderId) {
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add('drag-over');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    row.classList.remove('drag-over');
    const payload = readDragPayload(e);
    if (!payload) return;
    try {
      await moveItem(payload, targetFolderId);
    } catch (err) {
      alert('Failed to move: ' + err.message);
    }
  });
}

/** Build the DOM for one level of the tree (folders, then sessions, both at `parentId`). */
export function renderTreeLevel(parentId, folders, sessions) {
  const frag = document.createDocumentFragment();
  const childFolders = folders
    .filter((f) => (f.parentId ?? null) === parentId)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const childSessions = sessions
    .filter((s) => (s.folderId ?? null) === parentId)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  for (const folder of childFolders) frag.appendChild(renderFolderNode(folder, folders, sessions));
  for (const session of childSessions) frag.appendChild(renderSessionNode(session));
  return frag;
}

/** Count all sessions nested anywhere under a folder (for the count badge). */
function countSessionsUnder(folderId, allFolders, allSessions) {
  let count = allSessions.filter((s) => (s.folderId ?? null) === folderId).length;
  for (const f of allFolders.filter((f) => (f.parentId ?? null) === folderId)) {
    count += countSessionsUnder(f.id, allFolders, allSessions);
  }
  return count;
}

export function collectDescendantFolderIds(folderId, allFolders) {
  const ids = [];
  for (const f of allFolders.filter((f) => (f.parentId ?? null) === folderId)) {
    ids.push(f.id);
    ids.push(...collectDescendantFolderIds(f.id, allFolders));
  }
  return ids;
}

/** Flat, single-color folder icon (inherits color via currentColor) — used to set folder rows apart from session rows. */
const FOLDER_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3 7a2 2 0 0 1 2-2h4.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>' +
  '</svg>';

function renderFolderNode(folder, allFolders, allSessions) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-row';
  row.dataset.type = 'folder';

  const hasChildren =
    allFolders.some((f) => (f.parentId ?? null) === folder.id) ||
    allSessions.some((s) => (s.folderId ?? null) === folder.id);
  const isExpanded = expandedFolders.has(folder.id);

  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle' + (hasChildren ? '' : ' is-leaf');
  toggle.textContent = hasChildren ? (isExpanded ? '▾' : '▸') : '';
  row.appendChild(toggle);

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.innerHTML = FOLDER_ICON_SVG;
  row.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'tree-label tree-label-folder';
  label.textContent = folder.name || 'Untitled folder';
  row.appendChild(label);

  const total = countSessionsUnder(folder.id, allFolders, allSessions);
  const meta = document.createElement('span');
  meta.className = 'tree-meta';
  meta.textContent = total ? String(total) : '';
  row.appendChild(meta);

  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'tree-menu-btn';
  menuBtn.textContent = '⋯';
  menuBtn.title = 'Folder actions';
  menuBtn.draggable = false;
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openFolderMenu(menuBtn, folder);
  });
  row.appendChild(menuBtn);

  if (hasChildren) {
    row.addEventListener('click', () => {
      if (expandedFolders.has(folder.id)) expandedFolders.delete(folder.id);
      else expandedFolders.add(folder.id);
      renderHistoryTree();
    });
  }

  makeDraggable(row, 'folder', folder.id);
  makeDropTarget(row, folder.id);

  wrap.appendChild(row);

  if (isExpanded && hasChildren) {
    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'tree-children';
    childrenWrap.appendChild(renderTreeLevel(folder.id, allFolders, allSessions));
    wrap.appendChild(childrenWrap);
  }

  return wrap;
}

function renderSessionNode(session) {
  const row = document.createElement('div');
  row.className = 'tree-row tree-row-session';
  row.dataset.type = 'session';
  if (session.id === currentSessionId) row.classList.add('is-current');

  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle is-leaf';
  row.appendChild(toggle);

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = sessionDisplayName(session);
  label.title = formatDate(session.updatedAt || session.createdAt);
  row.appendChild(label);

  const n = (session.sentences || []).length;
  const scored = (session.sentences || []).filter((s) => s.assessment).length;
  const meta = document.createElement('span');
  meta.className = 'tree-meta';
  meta.textContent = scored ? `${scored}/${n}` : String(n);
  row.appendChild(meta);

  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'tree-menu-btn';
  menuBtn.textContent = '⋯';
  menuBtn.title = 'Session actions';
  menuBtn.draggable = false;
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openSessionMenu(menuBtn, session);
  });
  row.appendChild(menuBtn);

  row.addEventListener('click', () => openSession(session));

  makeDraggable(row, 'session', session.id);

  return row;
}

/** A session's display name: its custom name if renamed, else a preview of the practice text. */
export function sessionDisplayName(session) {
  if (session.name) return session.name;
  return session.inputText ? session.inputText.slice(0, 40) : '(empty)';
}