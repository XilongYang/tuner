// "Move to…" modal: a folder-tree picker with no store access of its own —
// it only presents the already-fetched `folders` list and resolves to
// whichever destination folder id the user picked (or `null` for root, or
// `undefined` if they cancelled) — actions.js decides what to do with that
// choice (openMovePicker() there fetches `folders` and performs the actual
// move).

import { collectDescendantFolderIds, sessionDisplayName } from './tree.js';

/** Show the picker for moving `item` (a folder or session, per `kind`) among
 *  `folders`. Returns a Promise resolving to the chosen folder id (or null
 *  for root), or undefined if the user cancelled. */
export function showMovePicker({ kind, item, folders }) {
  return new Promise((resolve) => {
    const excludeIds = new Set();
    if (kind === 'folder') {
      excludeIds.add(item.id);
      collectDescendantFolderIds(item.id, folders).forEach((id) => excludeIds.add(id));
    }

    let selected = kind === 'folder' ? (item.parentId ?? null) : (item.folderId ?? null);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target !== backdrop) return;
      backdrop.remove();
      finish(undefined);
    });

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
    cancelBtn.addEventListener('click', () => {
      backdrop.remove();
      finish(undefined);
    });
    actions.appendChild(cancelBtn);

    const moveBtn = document.createElement('button');
    moveBtn.className = 'btn primary';
    moveBtn.type = 'button';
    moveBtn.textContent = 'Move';
    moveBtn.addEventListener('click', () => {
      backdrop.remove();
      finish(selected);
    });
    actions.appendChild(moveBtn);

    card.appendChild(actions);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
  });
}
