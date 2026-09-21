// Rearranging a list by hand.
//
// Pointer events rather than HTML5 drag-and-drop: the same code then works for
// a mouse, a trackpad and a finger, and this list is read on a phone as often
// as on a desktop. (HTML5 dragstart never fires for touch.)
//
// The drag is started from a handle, not from the row. A row here is mostly
// buttons -- open, rename, delete -- and a row that is draggable everywhere
// turns every slightly-moved click into a drag. The handle is also a real
// button, so the arrangement can be changed from the keyboard: dragging is a
// gesture some people cannot make, and an order that can only be set by
// dragging cannot be set by them at all.
//
// Nothing here knows what the rows are. It reports where a row ended up, as the
// ids of the rows it landed between, and the caller decides what that means.

const THRESHOLD_PX = 4;

/**
 * Which row a dragged row should be placed in front of.
 *
 * Given each candidate's box and the pointer's position, the answer is the
 * first row whose middle is below the pointer. Pure, and separated out because
 * it is the only part of a drag with a right answer: everything else around it
 * is event plumbing.
 *
 * @param {Array<{top: number, height: number}>} boxes In list order.
 * @param {number} y
 * @returns {number} Index to insert before; `boxes.length` for the end.
 */
export function insertionIndex(boxes, y) {
  const at = boxes.findIndex((box) => y < box.top + box.height / 2);
  return at === -1 ? boxes.length : at;
}

/**
 * Make `list`'s children rearrangeable.
 *
 * @param {object} spec
 * @param {HTMLElement} spec.list
 * @param {string} spec.rowSelector
 * @param {string} spec.handleSelector Within a row.
 * @param {(row: HTMLElement) => string} spec.idOf
 * @param {(move: {id: string, beforeId: string|null, afterId: string|null}) => void} spec.onMove
 *   Told where a row ended up: the ids of the rows now above and below it.
 *   Not called when the row did not move.
 */
export function dragReorder({ list, rowSelector, handleSelector, idOf, onMove }) {
  let dragging = null;

  const rows = () => [...list.querySelectorAll(rowSelector)];

  const neighbours = (row) => {
    const all = rows();
    const at = all.indexOf(row);
    return {
      beforeId: at > 0 ? idOf(all[at - 1]) : null,
      afterId: at < all.length - 1 ? idOf(all[at + 1]) : null,
    };
  };

  function finish(commit) {
    if (!dragging) return;
    const { row, startNext, moved } = dragging;
    row.classList.remove('is-dragging');
    list.classList.remove('is-reordering');
    dragging = null;

    if (!moved) return;
    if (!commit) {
      // Back where it started. The list is put right immediately rather than
      // waiting for a refresh: a cancelled drag that leaves the row in the
      // wrong place until the next read looks exactly like a drag that worked.
      list.insertBefore(row, startNext);
      return;
    }
    onMove({ id: idOf(row), ...neighbours(row) });
  }

  list.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest?.(handleSelector);
    if (!handle || !list.contains(handle)) return;
    // A secondary button is a context menu, not a drag.
    if (event.button != null && event.button !== 0) return;
    const row = handle.closest(rowSelector);
    if (!row) return;

    event.preventDefault();
    dragging = { row, startY: event.clientY ?? 0, startNext: row.nextElementSibling, moved: false };
    handle.setPointerCapture?.(event.pointerId);
  });

  list.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const y = event.clientY ?? 0;
    // Below the threshold this is still a click on the handle: starting the
    // drag on the first pixel makes the row jump under a shaky finger.
    if (!dragging.moved && Math.abs(y - dragging.startY) < THRESHOLD_PX) return;
    if (!dragging.moved) {
      dragging.moved = true;
      dragging.row.classList.add('is-dragging');
      list.classList.add('is-reordering');
    }

    const others = rows().filter((row) => row !== dragging.row);
    const at = insertionIndex(others.map((row) => boxOf(row)), y);
    list.insertBefore(dragging.row, others[at] ?? null);
  });

  list.addEventListener('pointerup', () => finish(true));
  list.addEventListener('pointercancel', () => finish(false));
  // Escape during a drag puts it back, which is the only way out of a gesture
  // that has already started on a touchscreen.
  list.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dragging) finish(false);
  });

  /**
   * The keyboard path: the handle moves its own row one place at a time.
   *
   * It reports the move the same way a drag does and then gives the focus back
   * to the handle, so repeated presses walk the row up or down the list instead
   * of moving it once and losing the place.
   */
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const handle = event.target.closest?.(handleSelector);
    if (!handle) return;
    const row = handle.closest(rowSelector);
    if (!row) return;

    const all = rows();
    const at = all.indexOf(row);
    const to = event.key === 'ArrowUp' ? at - 1 : at + 1;
    if (to < 0 || to >= all.length) return;

    event.preventDefault();
    if (event.key === 'ArrowUp') list.insertBefore(row, all[to]);
    else list.insertBefore(row, all[to].nextElementSibling);
    onMove({ id: idOf(row), ...neighbours(row) });
  });

  return {
    /** Stop a drag that is in flight, because the list under it is about to change. */
    cancel: () => finish(false),
  };
}

const boxOf = (row) => {
  const rect = row.getBoundingClientRect?.() ?? { top: 0, height: 0 };
  return { top: rect.top, height: rect.height };
};
