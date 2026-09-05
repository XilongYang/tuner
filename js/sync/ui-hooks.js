// Shared UI-callback registry for the sync/data layer. Both azure-sync.js
// (the incremental merge sync) and restore.js (the full "replace everything"
// restore) need to trigger the same three post-sync repaints, but neither
// may import sentence-panel/history-panel directly -- see azure-sync.js's
// module comment for the F-01 coupling-audit finding this exists to avoid (a
// sync/data module reaching up into the UI layer is a reverse dependency).
// Kept in its own tiny file rather than defined in (and imported from)
// whichever of the two happened to need it first, so neither sync module
// depends on the other just to share this.

export let uiHooks = {
  render: () => {},
  applyIncomingSessionUpdate: () => {},
  refreshHistoryTreeIfOpen: () => {},
};

/** Called once by app.js (the composition root) to give the sync layer its
 *  real post-sync UI callbacks. Until wired, the no-ops above just mean a
 *  sync/restore run doesn't repaint anything -- relevant only to an isolated
 *  unit test that imports azure-sync.js/restore.js directly without going
 *  through app.js's init(). `uiHooks` is exported as a live binding (`let`,
 *  not `const`), so azure-sync.js/restore.js importing it see this
 *  reassignment automatically, the same way they already see any other
 *  live-exported binding. */
export function setSyncUiHooks(hooks) {
  uiHooks = { ...uiHooks, ...hooks };
}
