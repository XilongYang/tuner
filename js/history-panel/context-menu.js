// Small popup context menu (the "..." button on a folder/session row) and
// the folder/session action lists it offers.

import {
  promptCreateFolder, startRenameFolder, startRenameSession,
  confirmDeleteFolder, confirmDeleteSession, openMovePicker,
} from './actions.js';
import { openSession } from './session-open.js';

let openMenuEl = null;

// ---- Popup context menu (folder / session actions) ----

function onCtxMenuKeydown(e) {
  if (e.key === 'Escape') closeCtxMenu();
}

export function closeCtxMenu() {
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

export function openFolderMenu(anchorEl, folder) {
  openCtxMenu(anchorEl, [
    { label: 'New subfolder', onClick: () => promptCreateFolder(folder.id) },
    { label: 'Rename', onClick: () => startRenameFolder(folder) },
    { label: 'Move to…', onClick: () => openMovePicker({ kind: 'folder', item: folder }) },
    'separator',
    { label: 'Delete folder', danger: true, onClick: () => confirmDeleteFolder(folder) },
  ]);
}

export function openSessionMenu(anchorEl, session) {
  openCtxMenu(anchorEl, [
    { label: 'Open', onClick: () => openSession(session) },
    { label: 'Rename', onClick: () => startRenameSession(session) },
    { label: 'Move to…', onClick: () => openMovePicker({ kind: 'session', item: session }) },
    'separator',
    { label: 'Delete', danger: true, onClick: () => confirmDeleteSession(session) },
  ]);
}