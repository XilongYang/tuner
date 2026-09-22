// One run at a time, and at most one waiting behind it.
//
// For work that must not overlap with itself and that gets asked for from
// several places at once -- a sync round, asked for by startup, by an edit
// settling, and by the button in Settings.
//
// Waiting rather than joining: a caller asking now is asking about the state
// now, and the run already going read its plan before that. Joining would
// answer their question with an older one's answer. At most one waits, because
// the fifth request made during one long run wants the same thing the second
// one did.

/**
 * @template T
 * @param {(...args: any[]) => Promise<T>} run
 * @returns {(...args: any[]) => Promise<T>} The same function, serialised.
 */
export function serialize(run) {
  let inFlight = null;
  let queued = null;

  const call = (...args) => {
    if (!inFlight) {
      inFlight = Promise.resolve()
        .then(() => run(...args))
        .finally(() => { inFlight = null; });
      return inFlight;
    }

    if (!queued) {
      queued = inFlight
        // A failed run is still a finished run: the next one starts either way
        // and reports its own outcome. Swallowed here only so the wait can
        // proceed -- the caller of the failed run still sees its rejection.
        .catch(() => {})
        .then(() => {
          queued = null;
          return call(...args);
        });
    }
    return queued;
  };

  return call;
}
