// The History sidebar: the folder/session tree (render / drag-drop / context
// menu / rename / move / delete), and reconciling the live sentence list with
// a session opened from it or updated underneath it by a sync.

import * as store from './store.js';
import { saveHistoryOpen } from './config.js';
import { Recorder } from './recorder.js';
import {
  els,
  sentences,
  setSentences,
  currentSessionId,
  setCurrentSessionId,
  formatDate,
  isSentenceBusy,
} from './state.js';
import { render } from './sentence-panel.js';
import { scheduleAutoSync } from './sync.js';

// ---- History sidebar (folder tree: browse / rename / move / reopen / delete) ----

let historyPanelOpen = false;
let expandedFolders = new Set();
let openMenuEl = null;

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

async function renderHistoryTree() {
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
function makeDraggable(row, kind, id) {
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
function makeDropTarget(row, targetFolderId) {
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
    } catch (err) {
      alert('Failed to move: ' + err.message);
    }
  });
}

/** Build the DOM for one level of the tree (folders, then sessions, both at `parentId`). */
function renderTreeLevel(parentId, folders, sessions) {
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

function collectDescendantFolderIds(folderId, allFolders) {
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
function sessionDisplayName(session) {
  if (session.name) return session.name;
  return session.inputText ? session.inputText.slice(0, 40) : '(empty)';
}

// ---- Popup context menu (folder / session actions) ----

function onCtxMenuKeydown(e) {
  if (e.key === 'Escape') closeCtxMenu();
}

function closeCtxMenu() {
  if (!openMenuEl) return;
  openMenuEl.remove();
  openMenuEl = null;
  document.removeEventListener('click', closeCtxMenu, true);
  document.removeEventListener('keydown', onCtxMenuKeydown, true);
}

/** Open a small popup menu anchored under `anchorEl`. `items`: [{label, danger?, onClick}] or 'separator'. */
function openCtxMenu(anchorEl, items) {
  closeCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const item of items) {
    if (item === 'separator') {
      menu.appendChild(document.createElement('hr'));
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.label;
    if (item.danger) btn.classList.add('danger');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeCtxMenu();
      item.onClick();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);

  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = rect.right - menuRect.width;
  let top = rect.bottom + 4;
  if (left < 8) left = 8;
  if (top + menuRect.height > window.innerHeight - 8) top = rect.top - menuRect.height - 4;
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  openMenuEl = menu;
  // Defer listener registration one tick so the click that opened the menu doesn't also close it.
  setTimeout(() => {
    document.addEventListener('click', closeCtxMenu, true);
    document.addEventListener('keydown', onCtxMenuKeydown, true);
  }, 0);
}

function openFolderMenu(anchorEl, folder) {
  openCtxMenu(anchorEl, [
    { label: 'New subfolder', onClick: () => promptCreateFolder(folder.id) },
    { label: 'Rename', onClick: () => startRenameFolder(folder) },
    { label: 'Move to…', onClick: () => openMovePicker({ kind: 'folder', item: folder }) },
    'separator',
    { label: 'Delete folder', danger: true, onClick: () => confirmDeleteFolder(folder) },
  ]);
}

function openSessionMenu(anchorEl, session) {
  openCtxMenu(anchorEl, [
    { label: 'Open', onClick: () => openSession(session) },
    { label: 'Rename', onClick: () => startRenameSession(session) },
    { label: 'Move to…', onClick: () => openMovePicker({ kind: 'session', item: session }) },
    'separator',
    { label: 'Delete', danger: true, onClick: () => confirmDeleteSession(session) },
  ]);
}

// ---- Folder / session actions ----

async function promptCreateFolder(parentId) {
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

async function startRenameFolder(folder) {
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

async function startRenameSession(session) {
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

async function confirmDeleteFolder(folder) {
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

async function confirmDeleteSession(session) {
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
async function openMovePicker({ kind, item }) {
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

/**
 * Build a live, on-screen sentence object from a stored/incoming record.
 * Shared by openSession() (full reload) and applyIncomingSessionUpdate()
 * (partial, sync-driven refresh of the session already on screen).
 */
function makeLiveSentence(s) {
  return {
    // Keep the sentence's original id stable: it's what ties a saved
    // recording to its blob path on Azure (tuner/recordings/<sessionId>/<sentenceId>.wav).
    // Reassigning a fresh one here would orphan the old blob on the next sync.
    id: s.id ?? crypto.randomUUID(),
    text: s.text,
    lang: s.lang,
    hidden: s.hidden,
    recorder: new Recorder(),
    recordingUrl: s.recordingBlob ? URL.createObjectURL(s.recordingBlob) : null,
    recordingBlob: s.recordingBlob || null,
    recordingHash: s.recordingHash || null,
    // Sentence-level sync version; not shown in the UI, just carried through
    // so a later persistSession() doesn't lose it and make everything look
    // freshly-changed to the next sync.
    updatedAt: s.updatedAt || null,
    assessment: s.assessment || null,
    assessmentHash: s.assessmentHash || null,
  };
}

/** Load a saved session back onto the screen, replacing whatever is currently shown. */
function openSession(item) {
  for (const s of sentences) s.recorder.dispose();

  els.input.value = item.inputText || '';
  if (item.splitMode) els.splitMode.value = item.splitMode;

  setSentences((item.sentences || []).map(makeLiveSentence));

  setCurrentSessionId(item.id);
  render();
  refreshHistoryTreeIfOpen(); // keep the sidebar open; just update the "current" highlight
}

/**
 * Apply an incoming (post-sync-merge) copy of the session currently on
 * screen, without the disruption of a full openSession() reload: a sentence
 * whose persisted fields didn't actually change keeps its live object
 * (Recorder instance, open word-tip popover, everything) untouched, and a
 * BUSY sentence (mid-recording, or mid a word Retest -- see isSentenceBusy())
 * is left alone for this round even if it did change remotely; it picks up
 * that change on the next sync, once it's free. Session-level metadata is
 * applied the same way, skipping the practice-text box while it's focused.
 */
export function applyIncomingSessionUpdate(refreshed) {
  if (document.activeElement !== els.input) {
    const nextInput = refreshed.inputText || '';
    if (els.input.value !== nextInput) els.input.value = nextInput;
  }
  if (refreshed.splitMode && els.splitMode.value !== refreshed.splitMode) {
    els.splitMode.value = refreshed.splitMode;
  }

  const liveById = new Map(sentences.map((s) => [s.id, s]));
  let changed = false;
  const next = (refreshed.sentences || []).map((rs) => {
    const live = liveById.get(rs.id);
    if (!live) { changed = true; return makeLiveSentence(rs); }
    const samePersisted =
      live.text === rs.text &&
      live.lang === rs.lang &&
      live.hidden === rs.hidden &&
      (live.recordingHash || null) === (rs.recordingHash || null) &&
      JSON.stringify(live.assessment || null) === JSON.stringify(rs.assessment || null);
    if (samePersisted) return live;
    if (isSentenceBusy(rs.id)) return live; // leave it alone this round
    changed = true;
    live.recorder.dispose();
    return makeLiveSentence(rs);
  });
  // Sentences are never added to or removed from a session after Split (see
  // handleSplit), so `next` always has the same ids as the live array --
  // nothing to reconcile beyond what the map above already does.

  if (changed) {
    setSentences(next);
    render();
  }
  setCurrentSessionId(refreshed.id);
  refreshHistoryTreeIfOpen();
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

