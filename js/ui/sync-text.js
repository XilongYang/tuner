// What a sync round is called, in words.
//
// Two places show it -- the header's indicator and the settings panel -- and
// they show the same round, so the wording lives here rather than in both. The
// outcome shapes come from app/commands/sync.js; nothing here touches the DOM,
// so it is all testable as plain functions.

/** Which of the three states an outcome puts the indicator in. */
export function syncState(outcome) {
  if (!outcome) return 'syncing';
  if (outcome.ok) return 'synced';
  // Another device holding the lock is not this device failing: the round will
  // happen, a little later, and red belongs to something being wrong.
  if (outcome.reason === 'locked' || String(outcome.reason).startsWith('locked-by:')) return 'syncing';
  if (outcome.reason === 'not-configured') return 'off';
  return 'failed';
}

/** Exactly three words, so the header never has to make room for a sentence. */
export const SYNC_LABELS = {
  syncing: 'Syncing',
  synced: 'Synced',
  failed: 'Sync Failed',
};

export const syncProgress = (progress) => (progress?.total
  ? `Syncing ${progress.done ?? 0} / ${progress.total}…`
  : 'Syncing…');

/** The one-line account of a finished round. */
export function describeSync(outcome) {
  if (!outcome.ok) {
    if (outcome.reason === 'not-configured') return 'Add a container SAS URL first.';
    if (String(outcome.reason).startsWith('locked-by:')) return `Another device (${outcome.reason.slice('locked-by:'.length)}) is syncing. Try again shortly.`;
    if (outcome.reason === 'locked') return 'Another device is syncing. Try again shortly.';
    return `Sync failed: ${outcome.reason}`;
  }
  const parts = [`${outcome.uploaded} uploaded`, `${outcome.downloaded} downloaded`];
  if (outcome.deleted) parts.push(`${outcome.deleted} deleted`);
  if (outcome.skipped) parts.push(`${outcome.skipped} left for the next round`);
  if (outcome.swept) parts.push(`${outcome.swept} orphaned file${outcome.swept === 1 ? '' : 's'} removed`);
  // A warning says something was lost or left behind, so the first one is shown
  // in full rather than counted: a bare "(1 warning)" with no way to read it is
  // worth nothing to the person who has to decide what to do about it.
  const [first, ...rest] = outcome.warnings || [];
  if (!first) return `Sync complete — ${parts.join(', ')}.`;
  return `Sync complete — ${parts.join(', ')}. ${first}${rest.length ? ` (and ${rest.length} more)` : ''}`;
}

/**
 * Wall-clock time to the millisecond.
 *
 * Seconds would do for reading, but two rounds a second apart must not produce
 * the same tooltip: "Synced at ..." that never changes reads as a sync that
 * never ran.
 */
export function formatSyncTime(at) {
  const d = new Date(at);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * The indicator's hover text.
 *
 * A finished round gets two lines: when it finished, then what it did. The
 * round's own message carries no time of its own, and "when" is the thing a
 * person actually wants from a dot that says Synced.
 */
export function syncTooltip({ state, detail, at }) {
  if (state !== 'synced') return detail || '';
  const account = (detail || '').replace(/^Sync complete — /, '');
  return `Synced at ${formatSyncTime(at ?? Date.now())}\n${account}`;
}
