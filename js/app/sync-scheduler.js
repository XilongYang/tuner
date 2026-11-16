// What happens around a sync round: the queue that keeps two rounds in one tab
// apart, the save that is flushed first, and the re-read of the session on
// screen once a round has landed.
//
// Rounds are manual. Nothing here starts one: not an edit, not startup, not a
// container being configured. A round runs when a person asks for it, which is
// why `request` is the only way in. (It used to debounce after every edit and
// run at startup; a sync that arrives uninvited is one that can change the
// screen, or fail, while the person is looking at something else.)
//
// Nothing here draws. A round's progress and outcome are announced as events,
// and whoever owns the indicator subscribes; the wording for those outcomes is
// ui/'s (ui/sync-text.js), which this module cannot import and does not need.

import { syncNow, eraseCloud } from './commands/sync.js';
import { reloadOnScreen } from './commands/session.js';
import { serialize } from './serialize.js';

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
 */
export function createSyncScheduler({
  store, db, settings, hash, autosave, container,
  clock = Date.now,
  sync = syncNow,
  erase = eraseCloud,
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

  return {
    /** @param {(event: SyncEvent) => void} listener */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** A round now, asked for by a person. Resolves to its outcome. */
    request: (onProgress) => lane(() => round(onProgress)),

    /**
     * Tell the indicator whether there is anywhere to sync to: called at
     * startup and when a container is set or forgotten in Settings. It never
     * starts a round -- the person presses Sync when they want one -- and with
     * no container it takes the indicator away.
     */
    reportAvailability() {
      if (!container()) emit({ phase: 'off' });
    },

    /** Empty the container, in the same lane as the rounds, */
    erase: (onProgress) => lane(() => erase({
      deps: { container: container(), settings, onProgress },
    })),
  };
}
