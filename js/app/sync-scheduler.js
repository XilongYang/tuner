// What happens around a sync round: the queue that keeps two rounds in one tab
// apart, the save that is flushed first, and the re-read of the session on
// screen once a round has landed.
//
// Rounds run by themselves and on request: once at startup, once when a
// container is configured, and a few seconds after edits settle. A round that
// finds another device holding the container lock is simply skipped (the
// indicator reads "syncing"), and one that fails says so on the indicator and
// nowhere else; only a round a person asked for (`request`) reports to them
// directly. What a round brings in reaches the screen only through
// `applyIncoming`, which leaves alone a session edited since.
//
// Nothing here draws. A round's progress and outcome are announced as events,
// and whoever owns the indicator subscribes; the wording for those outcomes is
// ui/'s (ui/sync-text.js), which this module cannot import and does not need.

import { syncNow, eraseCloud } from './commands/sync.js';
import { reloadOnScreen } from './commands/session.js';
import { serialize } from './serialize.js';

/** How long edits settle before the round that publishes them. */
export const AUTO_SYNC_DELAY_MS = 3000;

/**
 * @typedef {{phase: 'off'}
 *   | {phase: 'started'}
 *   | {phase: 'progress', progress: object}
 *   | {phase: 'finished', outcome: object, at: number}} SyncEvent
 */

/**
 * @param {object} deps
 * @param {import('./store.js').SessionStore} deps.store
 * @param {object} deps.db
 * @param {object} deps.settings
 * @param {object} deps.hash
 * @param {{flush: () => Promise<void>, reset: Function}} deps.autosave
 * @param {() => object|null} deps.container The container as configured right
 *   now, or null. A function, because the SAS URL can change between rounds.
 * @param {() => number} [deps.clock]
 * @param {typeof syncNow} [deps.sync]     Injected by tests.
 * @param {typeof eraseCloud} [deps.erase] Injected by tests.
 * @param {number} [deps.delayMs]
 * @param {(fn: Function, ms: number) => any} [deps.schedule]
 * @param {(handle: any) => void} [deps.cancel]
 */
export function createSyncScheduler({
  store, db, settings, hash, autosave, container,
  clock = Date.now,
  sync = syncNow,
  erase = eraseCloud,
  delayMs = AUTO_SYNC_DELAY_MS,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  const listeners = new Set();
  const emit = (event) => {
    for (const listener of [...listeners]) listener(event);
  };

  /**
   * One round, and what the screen does afterwards.
   *
   * A round may have merged a change into the session on screen. The stored
   * copy is offered back so the user sees what was merged -- and refused by
   * `applyIncoming` when it says nothing new, which is most rounds. Replacing
   * it anyway would move the store's version and swap every Blob for a fresh
   * read, which is what a score or a split in flight is pinned against.
   */
  async function round(onProgress) {
    emit({ phase: 'started' });
    // What was just typed is written before the round plans, so it is in the
    // round rather than a step behind it.
    await autosave.flush();
    const outcome = await sync({
      deps: {
        container: container(), db, settings, hash,
        onProgress: (progress) => {
          emit({ phase: 'progress', progress });
          onProgress?.(progress);
        },
      },
    });
    if (outcome.ok) {
      await reloadOnScreen({ store, db, autosave });
    }
    emit({ phase: 'finished', outcome, at: clock() });
    return outcome;
  }

  // One lane for everything that holds the container lock from this tab: two
  // rounds, or a round and an erase, would have the second refused by this
  // device's own lock and reported as another device syncing -- a lie told to
  // the person who just pressed the button. At most one waits behind the run
  // in progress (see ./serialize.js).
  const lane = serialize((job) => job());

  // Edits settle, then one round: a burst of changes is one thing to publish.
  // What a save writes back and what a round brought in are not edits. The
  // round flushes the save itself, so it plans against what was just typed.
  let handle = null;
  store.subscribe((_session, { reason }) => {
    if (reason === 'saved' || reason === 'incoming') return;
    if (!container()) return;
    if (handle !== null) cancel(handle);
    handle = schedule(() => {
      handle = null;
      lane(() => round()).catch(() => {});
    }, delayMs);
  });

  return {
    /** @param {(event: SyncEvent) => void} listener */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** A round now, asked for by a person. Resolves to its outcome. */
    request: (onProgress) => lane(() => round(onProgress)),

    /**
     * Called at startup and when a container is set or forgotten in Settings.
     * With none it takes the indicator away; with one it runs a round, so what
     * is already up there is here before the person goes looking for it.
     */
    reportAvailability() {
      if (!container()) {
        emit({ phase: 'off' });
        return Promise.resolve(null);
      }
      return lane(() => round());
    },

    /** Empty the container, in the same lane as the rounds, */
    erase: (onProgress) => lane(() => erase({
      deps: { container: container(), settings, onProgress },
    })),
  };
}
