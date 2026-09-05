// Automatic sync scheduling: a debounced local-change trigger, a sync right
// after page load, and a catch-up sync when the tab becomes visible again --
// all funneled through a Web Locks cross-tab-exclusive runner so only one
// tab ever does the network round-trip + IndexedDB writes at a time. See the
// big comment below for the triggers.
//
// There used to also be an unconditional 30s idle heartbeat (a setInterval
// re-running runAutoSync() on a timer, regardless of whether anything
// local had changed). Removed: every extra sync round is another window in
// which this device's orphan-blob cleanup (azure-sync.js's syncWithAzure())
// can race a concurrently-syncing OTHER device -- see referencedBlobPaths()'s
// doc comment in ./blob-paths.js for the actual failure mode this caused
// (a manifest upload succeeding while that same round's cleanup deletes a
// blob another device had just finished uploading). A device with nothing
// to say has no reason to sync every 30s just to find that out; the
// debounced on-edit sync and the on-return-to-tab catch-up below are
// already the trigger for "something might have changed, worth checking."

import { hasBlobSasUrl } from '../config.js';
import { isSessionBusy } from '../state.js';
import { syncWithAzure } from './azure-sync.js';

const AUTO_SYNC_DEBOUNCE_MS = 3000;
const AUTO_SYNC_LOCK_NAME = 'tuner-cloud-sync';

let autoSyncDebounceTimer = null;
let autoSyncRunning = false; // this tab only; the Web Locks lock below is what actually coordinates across tabs

/**
 * Run syncWithAzure() under the cross-tab lock -- shared by the manual "Sync
 * now" click and the automatic triggers below, so a manual click can never
 * overlap an automatic run IN THE SAME TAB either (without this, the two
 * paths would call syncWithAzure() independently and could run concurrently,
 * reintroducing exactly the read-then-write races the lock is meant to rule
 * out). `wait: true` means a manual click queues behind an in-progress
 * automatic sync instead of silently skipping -- the user asked for it, so it
 * should happen, just after the one already running finishes.
 */
export async function runSyncExclusive({ wait, fn = syncWithAzure }) {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    // No Web Locks support (older browser): same-tab-only guard. Cross-tab
    // races become possible, but this tab still never overlaps itself.
    if (autoSyncRunning) return;
    autoSyncRunning = true;
    try { await fn(); } finally { autoSyncRunning = false; }
    return;
  }
  await navigator.locks.request(AUTO_SYNC_LOCK_NAME, wait ? {} : { ifAvailable: true }, async (lock) => {
    if (!lock) return; // another tab is already syncing -- this round is skipped, not queued
    autoSyncRunning = true;
    try { await fn(); } finally { autoSyncRunning = false; }
  });
}

/** The manual "Sync now" button: always runs, queuing behind any sync already in progress. */
export function runSyncNow() {
  return runSyncExclusive({ wait: true });
}

/** Debounce a local change into an automatic sync a few seconds from now. No-op if cloud sync isn't configured. */
export function scheduleAutoSync(delayMs = AUTO_SYNC_DEBOUNCE_MS) {
  if (!hasBlobSasUrl()) return;
  clearTimeout(autoSyncDebounceTimer);
  autoSyncDebounceTimer = setTimeout(runAutoSync, delayMs);
}

/**
 * Entry point for both automatic triggers (a debounced local change, and the
 * load/return-to-tab catch-up below). Never shows a blocking alert() or asks
 * for confirmation (those are for the manual "Sync now" click) -- a failure
 * here just leaves the status line saying so and waits for the next
 * trigger.
 */
async function runAutoSync() {
  if (!hasBlobSasUrl()) return;
  if (isSessionBusy()) {
    // Don't drop the change: try again shortly rather than waiting for the
    // next unrelated trigger, which might otherwise be a long time coming
    // now that there's no periodic heartbeat to fall back on (e.g.
    // mid-recording a long sentence, with no other local edit in sight).
    scheduleAutoSync(AUTO_SYNC_DEBOUNCE_MS);
    return;
  }
  await runSyncExclusive({ wait: false });
}

let autoSyncStarted = false;

/** Sync once right after load, and again whenever the tab regains visibility -- catch-up points for whatever changed elsewhere while this tab wasn't the one looking. No periodic timer beyond that (see the module comment above for why). */
export function startAutoSync() {
  if (autoSyncStarted) return;
  autoSyncStarted = true;
  if (!document.hidden) runAutoSync();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) runAutoSync();
  });
}