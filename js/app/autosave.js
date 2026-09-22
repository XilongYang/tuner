// Keeping the stored copy of the session on screen up to date.
//
// One subscriber does this for every change, rather than each command
// remembering to save after it acts. A command that forgets is invisible until
// a reload, and there is no reason for the twentieth command to have to
// remember what the first nineteen did.
//
// Saves are coalesced: typing, toggling and recording produce bursts of
// changes, and hashing then writing each one separately is wasted work. The
// last state wins, which is the only one that matters.
//
// A session with nothing in it is not written at all -- see isWorthStoring().

import { isWorthStoring } from '../model/session.js';

/**
 * @param {object} deps
 * @param {import('./store.js').SessionStore} deps.store
 * @param {{put: Function}} deps.db
 * @param {object} deps.hash
 * @param {number} [deps.delayMs]
 * @param {(fn: Function, ms: number) => any} [deps.schedule]
 * @param {(handle: any) => void} [deps.cancel]
 * @param {(error: Error) => void} [deps.onError] Told when a save fails. Saving
 *   is the write behind every edit, so a failure is the user's business: left
 *   silent, they can practise for an hour with nothing being kept.
 * @param {(record: object) => Promise<object>|object} [deps.prepare] Last look
 *   at the record before it is stored. This is where a session first joining
 *   the library gets its place in it (see commands/order.js); autosave itself
 *   has no opinion about the list.
 */
export function createAutosave({
  store,
  db,
  hash,
  saveRecord,
  prepare = (record) => record,
  delayMs = 400,
  schedule = setTimeout,
  cancel = clearTimeout,
  onError = () => {},
}) {
  let handle = null;
  let lastSaved = null;
  let inFlight = null;
  let pendingAgain = false;

  async function writeNow() {
    const session = store.get();
    if (!session) return;
    // Nothing has been split or imported into it yet, so there is nothing to
    // keep. Saving it would put an empty row in the library, and give the next
    // sync a record with no content to carry.
    if (!isWorthStoring(session)) return;

    try {
      // `previous` lets unchanged content keep its hash instead of being
      // re-read; see persist.js.
      const stored = await saveRecord('sessions', await prepare(session), { db, hash, previous: lastSaved });
      lastSaved = stored;

      // The stamped record carries hashes the one on screen lacks. Put it back,
      // but only if nothing changed meanwhile -- otherwise this would overwrite
      // the newer state with the one that was just saved.
      store.apply((current) => (current && current.id === stored.id && current === session ? stored : null), 'saved');
    } catch (err) {
      onError(err);
    }
  }

  /**
   * Write, and keep writing while changes arrive during a write.
   *
   * The loop is what makes the returned promise mean "everything asked for so
   * far is written". `inFlight` is cleared in the same synchronous step that
   * leaves the loop, so there is no moment where a caller can see a save in
   * flight that will never run again.
   */
  async function cycle() {
    try {
      do {
        pendingAgain = false;
        await writeNow();
      } while (pendingAgain);
    } finally {
      inFlight = null;
    }
  }

  function run() {
    handle = null;
    // A save is already running: let it finish and go again, rather than
    // interleaving two writes of the same record. The caller gets that whole
    // chain, not just the write that happens to be running now -- flush()
    // waiting on the older write would return before the newest state was
    // stored, which is exactly what flush exists to prevent.
    if (inFlight) {
      pendingAgain = true;
      return inFlight;
    }
    inFlight = cycle();
    return inFlight;
  }

  const unsubscribe = store.subscribe((_session, { reason }) => {
    // The write-back of a record this module just saved is not a reason to save
    // again; without this it would loop forever.
    if (reason === 'saved') return;
    if (handle !== null) cancel(handle);
    handle = schedule(run, delayMs);
  });

  return {
    /** Write immediately, for a moment that must not be lost: closing, switching away. */
    async flush() {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
      await run();
    },

    /** Forget what was last saved, so the next save re-hashes everything. Used when the session on screen is replaced by a different one. */
    reset(known = null) {
      lastSaved = known;
    },

    stop() {
      if (handle !== null) cancel(handle);
      handle = null;
      unsubscribe();
    },
  };
}
