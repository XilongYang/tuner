// The session on screen: one value, a version that counts every change, and
// subscribers that hear about each one.
//
// Two rules make the races this app kept hitting unrepresentable.
//
// A change is expressed as a function of the CURRENT session, not as an edit to
// a copy the caller read earlier. Commands do slow work -- decoding audio,
// scoring a take, a sync round-trip -- and then apply the result; if they
// applied a value computed from the session as it was before, they would
// silently undo whatever happened meanwhile.
//
// And a caller that must not overwrite a newer change can pin its work to the
// version it started from. `applyIfUnchanged` refuses rather than clobbering,
// which is the same guarantee db/entities.js's applyPlan gives the database.
//
// The store holds data only. Anything with a lifecycle -- a recorder, an object
// URL, a pending request -- is held by whatever created it, keyed by sentence
// id. That is why nothing here needs disposing, and why a sync landing does not
// have to know that recorders exist.

/**
 * @typedef {object} SessionStore
 * @property {() => object|null} get
 * @property {() => number} version
 * @property {(listener: (session: object|null, meta: {version: number, reason: string}) => void) => () => void} subscribe
 * @property {(change: (session: object|null) => object|null, reason?: string) => boolean} apply
 * @property {(expectedVersion: number, change: (session: object|null) => object|null, reason?: string) => boolean} applyIfUnchanged
 * @property {(session: object|null, reason?: string) => boolean} replace
 */

/** @returns {SessionStore} */
export function createSessionStore(initial = null) {
  let session = initial;
  let version = 0;
  const listeners = new Set();

  function notify(reason) {
    // A copy, so a listener that unsubscribes (or subscribes) while being
    // notified cannot alter the set being walked.
    for (const listener of [...listeners]) listener(session, { version, reason });
  }

  function commit(next, reason) {
    // Returning the same object means "nothing to do" -- the model's transforms
    // do exactly that when asked to change something that is no longer there.
    // Treating that as a change would repaint the screen and bump the version
    // for nothing.
    if (next === session) return false;
    session = next;
    // The version is "has this moved since you looked", which is what a command
    // pins its slow work against. Storing the session and putting the stamped
    // record back is not movement: it is the same session with its content
    // hashes filled in, and counting it made a save landing mid-split cancel
    // the split -- with nothing on screen having changed to explain it.
    // Listeners are still told, because the object they hold is a new one.
    if (reason !== 'saved') version += 1;
    notify(reason);
    return true;
  }

  return {
    get: () => session,
    version: () => version,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Apply a change computed from the current session.
     *
     * `change` returning null (the model's way of refusing) leaves the store
     * alone; to actually clear the session, use `replace(null)`.
     *
     * @returns {boolean} whether anything changed.
     */
    apply(change, reason = 'apply') {
      const next = change(session);
      if (next == null) return false;
      return commit(next, reason);
    },

    /**
     * The same, but only if the store is still at `expectedVersion`.
     *
     * This is what a command uses after slow work: it took the version before
     * starting, and if something moved since -- another edit, an arriving sync
     * -- its result is stale and is dropped rather than applied over the newer
     * state. The next round recomputes from what is actually there.
     *
     * @returns {boolean} false when refused, so the caller can say so.
     */
    applyIfUnchanged(expectedVersion, change, reason = 'apply') {
      if (version !== expectedVersion) return false;
      const next = change(session);
      if (next == null) return false;
      return commit(next, reason);
    },

    /**
     * Put a whole session in place, or clear it with null.
     *
     * Used when opening a session, starting a new one, and when a sync brings a
     * newer copy of the one on screen.
     */
    replace(next, reason = 'replace') {
      if (next === session) return false;
      session = next;
      version++;
      notify(reason);
      return true;
    },
  };
}
