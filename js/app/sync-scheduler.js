// When a sync round runs, and what the screen does when one has run.
//
// This is policy, and it used to live in the composition root: the debounce
// after an edit, the round at startup, the one when a container is first
// configured, the queue that keeps two rounds in one tab apart, and the
// re-read of the session on screen once a round has landed. Nothing there was
// under test, and the defect that put a sync in the way of a score in flight
// grew in exactly that gap -- there was no unit whose job it was to say what
// happens to the screen after a round.
//
// Nothing here draws. A round's progress and outcome are announced as events,
// and whoever owns the indicator subscribes; the wording for those outcomes is
// ui/'s (ui/sync-text.js), which this module cannot import and does not need.
//
// The manifest cache lives here because it belongs to the sequence of rounds:
// a round reads it, publishes, and writes it back for the next; emptying the
// container has to drop it. One owner, so a round and an erase cannot
// disagree about what the container currently says.

import { syncNow, eraseCloud } from './commands/sync.js';
import { applyIncoming } from './commands/session.js';
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
  let manifestCache = { etag: null, manifest: null };
  const manifestCacheApi = { get: () => manifestCache, set: (next) => { manifestCache = next; } };

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
    const outcome = await sync({
      deps: {
        container: container(), db, settings, hash, manifestCache: manifestCacheApi,
        onProgress: (progress) => {
          emit({ phase: 'progress', progress });
          onProgress?.(progress);
        },
      },
    });
    if (outcome.ok) {
      const current = store.get();
      const stored = current ? await db.getOne('sessions', current.id) : null;
      if (stored) applyIncoming({ store, session: stored, deps: { autosave } });
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

  // Edits settle, then one round. Coalesced the way saving is, for the same
  // reason: a burst of changes is one thing to publish, not twenty. The flush
  // first, so the round plans against what was just typed rather than what was
  // last written.
  let handle = null;
  const unsubscribe = store.subscribe((_session, { reason }) => {
    // What a save writes back, and what a round brought in, are not edits.
    if (reason === 'saved' || reason === 'incoming') return;
    if (!container()) return;
    if (handle !== null) cancel(handle);
    handle = schedule(async () => {
      handle = null;
      await autosave.flush();
      await lane(() => round());
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
     * The round at startup, so a session recorded on another device is here
     * before the user starts looking for it. With no container there is
     * nothing to run, and the indicator is told so.
     */
    start() {
      if (!container()) {
        emit({ phase: 'off' });
        return Promise.resolve(null);
      }
      return lane(() => round());
    },

    /**
     * A container was just set or forgotten in Settings. Setting one starts a
     * round straight away rather than waiting for the next edit: what is
     * already up there is what the user wants to see.
     */
    containerChanged() {
      if (!container()) {
        emit({ phase: 'off' });
        return Promise.resolve(null);
      }
      return lane(() => round());
    },

    /** Empty the container, in the same lane as the rounds, with the same cache. */
    erase: (onProgress) => lane(() => erase({
      deps: { container: container(), settings, manifestCache: manifestCacheApi, onProgress },
    })),

    stop() {
      if (handle !== null) cancel(handle);
      handle = null;
      unsubscribe();
    },
  };
}
