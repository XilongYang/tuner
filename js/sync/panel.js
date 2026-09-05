// The Cloud backup panel UI: the SAS-URL entry/saved states, the header's
// compact sync indicator (dot + Synced/Syncing/Sync Failed), the
// blob-action status line, and initBlobPanel() wiring it all up.

import {
  loadBlobSasUrl, saveBlobSasUrl, clearBlobSasUrl,
} from '../config.js';
import { els } from '../state.js';
import { scheduleAutoSync, runSyncNow, runSyncExclusive, startAutoSync } from './scheduler.js';
// Circular with restore.js (this file imports restoreFromAzure from there to
// wire the "Restore from Azure" button, while restore.js imports
// setBlobActionStatus from here) -- safe, same as the rest of this
// codebase's cycles: both sides only call into each other from inside
// functions, never at module-evaluation time.
import { restoreFromAzure } from './restore.js';

/** Millisecond-precision timestamp for the "Synced at ..." tooltip line --
 *  distinct from state.js's formatDate() (minute precision, used for session
 *  list timestamps), since this one needs to visibly tick between syncs. */
function formatSyncTimestamp(ts) {
  const d = new Date(ts);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function updateBlobPanel() {
  const url = loadBlobSasUrl();
  const has = !!url;
  els.blobEntry.hidden = has;
  els.blobSaved.hidden = !has;
  if (has) {
    let host = url;
    try { host = new URL(url).hostname; } catch { /* keep raw value if unparsable */ }
    els.blobStatus.textContent = `SAS URL saved \u00b7 ${host}`;
  }
  // The header indicator only exists once cloud sync is configured at all;
  // hidden -> shown here, never the reverse (Clear SAS URL below un-configures
  // it again). A freshly-shown indicator starts in "syncing" state since
  // saving a SAS URL immediately kicks off a sync (see initBlobPanel()).
  els.syncIndicator.hidden = !has;
  if (has) updateSyncIndicator('Starting sync\u2026', 'info');
}

// Timestamp of the last sync that completed successfully (kind 'recording'),
// shown in the "Synced" tooltip. In-memory only -- resets on reload, same as
// manifestEtagCache; the next sync completing fills it back in within seconds.
let lastSyncAt = null;

/**
 * Drives the header's compact sync indicator (dot + one of exactly three
 * words: Synced / Syncing / Sync Failed) from the same (text, kind) pairs
 * setBlobActionStatus() already receives throughout syncWithAzure() and
 * restoreFromAzure() -- no separate state machine, just a different rendering
 * of the same signal. Hover (or focus, for keyboard/touch) reveals `text` in
 * full via the tooltip; for a successful completion, the tooltip also gets a
 * prepended timestamp since the underlying message doesn't carry one.
 */
export function updateSyncIndicator(text, kind) {
  const state = kind === 'recording' ? 'synced' : kind === 'error' ? 'failed' : 'syncing';
  els.syncIndicator.dataset.kind = state;
  els.syncIndicatorLabel.textContent = state === 'synced' ? 'Synced' : state === 'failed' ? 'Sync Failed' : 'Syncing';
  if (state === 'synced') {
    lastSyncAt = Date.now();
    const detail = text.replace(/^(Sync|Restore) complete \u2014 /, '');
    // Two lines: a fixed, always-present timestamp, then whatever detail this
    // sync/restore reported -- see the white-space: pre-line rule on
    // .sync-indicator-tooltip that makes the "\n" actually break the line.
    els.syncIndicatorTooltip.textContent = `Synced at ${formatSyncTimestamp(lastSyncAt)}\n${detail}`;
  } else {
    els.syncIndicatorTooltip.textContent = text;
  }
}

export function setBlobActionStatus(text, kind) {
  els.blobActionStatus.hidden = !text;
  els.blobActionStatus.textContent = text;
  if (kind) els.blobActionStatus.dataset.kind = kind;
  else delete els.blobActionStatus.dataset.kind;
  // Same underlying signal, rendered differently in the header -- see
  // updateSyncIndicator(). Only meaningful once the indicator is showing at
  // all (i.e. cloud sync is configured), which is exactly when this function
  // is ever called with a non-empty text in the first place.
  if (text) updateSyncIndicator(text, kind);
}
export function initBlobPanel() {
  els.saveBlobBtn.addEventListener('click', () => {
    const url = els.blobSasInput.value.trim();
    if (!url) {
      alert('Please paste a container SAS URL');
      return;
    }
    saveBlobSasUrl(url);
    els.blobSasInput.value = '';
    updateBlobPanel();
    scheduleAutoSync(0); // pick up whatever's already on Azure right away, rather than waiting for the first edit or heartbeat tick
  });

  els.clearBlobBtn.addEventListener('click', () => {
    clearBlobSasUrl();
    els.blobSasInput.value = '';
    updateBlobPanel();
  });

  els.backupNowBtn.addEventListener('click', runSyncNow);
  els.restoreNowBtn.addEventListener('click', () => runSyncExclusive({ wait: true, fn: restoreFromAzure }));

  updateBlobPanel();
  startAutoSync();
}
