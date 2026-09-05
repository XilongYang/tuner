// Automatic sync scheduling: a debounced local-change trigger plus a single
// sync right after page load, funneled through a Web Locks cross-tab-
// exclusive runner so only one tab ever does the network round-trip +
// IndexedDB writes at a time. See the big comment below for the triggers.
// The manual "Sync now" button (panel.js) is the only other way a sync
// starts.
//
// There used to also be an unconditional 30s idle heartbeat (a setInterval
// re-running runAutoSync() on a timer regardless of whether anything local
// had changed) and a catch-up sync on every tab-visibility change. Both
// removed: every extra sync round is another window in which this device's
// orphan-blob cleanup (azure-sync.js's syncWithAzure()) can race a
// concurrently-syncing OTHER device -- see referencedBlobPaths()'s doc
// comment in ./blob-paths.js for the actual failure mode this caused (a
// manifest upload succeeding while that same round's cleanup deletes a blob
// another device had just finished uploading). A device with nothing to say
// has no reason to sync just because a timer fired or a tab got focus; the
// debounced on-edit sync below, the one sync on load, and the manual button
// are the triggers that actually mean "something might have changed."

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
 * one-shot load-time sync below). Never shows a blocking alert() or asks for
 * confirmation (those are for the manual "Sync now" click) -- a failure here
 * just leaves the status line saying so and waits for the next trigger.
 */
async function runAutoSync() {
  if (!hasBlobSasUrl()) return;
  if (isSessionBusy()) {
    // Don't drop the change: try again shortly rather than waiting for the
    // next unrelated trigger -- with no periodic heartbeat and no
    // return-to-tab catch-up left, the next debounced edit could otherwise
    // be a long time coming (e.g. mid-recording a long sentence, with
    // nothing else happening in the meantime).
    scheduleAutoSync(AUTO_SYNC_DEBOUNCE_MS);
    return;
  }
  await runSyncExclusive({ wait: false });
}

let autoSyncStarted = false;

/** Sync once right after load -- the only automatic trigger besides a debounced local edit (see the module comment above for why the old periodic heartbeat and tab-visibility catch-up are both gone). */
export function startAutoSync() {
  if (autoSyncStarted) return;
  autoSyncStarted = true;
  runAutoSync();
}