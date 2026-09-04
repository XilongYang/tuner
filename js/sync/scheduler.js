// Automatic sync scheduling: a debounced local-change trigger plus a 30s
// idle heartbeat, both funneled through a Web Locks cross-tab-exclusive
// runner so only one tab ever does the network round-trip + IndexedDB
// writes at a time. See the big comment below for the two triggers.

import { hasBlobSasUrl } from '../config.js';
import { isSessionBusy } from '../state.js';
import { syncWithAzure } from './azure-sync.js';

const AUTO_SYNC_DEBOUNCE_MS = 3000;
const AUTO_SYNC_HEARTBEAT_MS = 30000;
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
 * 30s idle heartbeat). Never shows a blocking alert() or asks for
 * confirmation (those are for the manual "Sync now" click) -- a failure here
 * just leaves the status line saying so and waits for the next trigger.
 */
async function runAutoSync() {
  if (!hasBlobSasUrl()) return;
  if (isSessionBusy()) {
    // Don't drop the change: try again shortly rather than waiting for the
    // next unrelated trigger, which might be a while (e.g. mid-recording a
    // long sentence, or nothing else happens for the rest of the 30s window).
    scheduleAutoSync(AUTO_SYNC_DEBOUNCE_MS);
    return;
  }
  await runSyncExclusive({ wait: false });
}

let autoSyncHeartbeatTimer = null;

/** 30s idle heartbeat: only ticks while the tab is visible, so a backgrounded/pinned tab doesn't keep polling Azure and burning battery/quota. */
export function startAutoSyncHeartbeat() {
  if (autoSyncHeartbeatTimer) return;
  autoSyncHeartbeatTimer = setInterval(() => {
    if (document.hidden) return;
    runAutoSync();
  }, AUTO_SYNC_HEARTBEAT_MS);
  document.addEventListener('visibilitychange', () => {
    // Catch up promptly on returning to the tab, instead of waiting out
    // whatever's left of the current 30s tick.
    if (!document.hidden) runAutoSync();
  });
}