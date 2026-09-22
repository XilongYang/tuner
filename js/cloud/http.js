// One rule about talking to the network, in one place.
//
// `fetch()` has no default timeout. A request that stalls -- a connection that
// went away without closing, a captive portal, a proxy holding the socket open
// -- never settles, so the await never returns and whatever was waiting on it
// waits for the life of the page: a row stuck on "Preparing the reading…", a
// sync round that never finishes and blocks the next one.
//
// Both ./blob.js and ./speech.js need this, and a second copy of it is a second
// place for the deadline to be got wrong.

/**
 * `fetch`, with a deadline.
 *
 * A timeout arrives as an Error carrying `timedOut`, so a caller can tell "the
 * network is slow" from "the server said no" -- they read the same at the
 * transport level and mean completely different things to the person.
 *
 * @param {string} url
 * @param {RequestInit} opts
 * @param {number} timeoutMs
 */
export async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      const timedOut = new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
      timedOut.timedOut = true;
      throw timedOut;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A deadline that allows for the size of what is being sent.
 *
 * An upload's `fetch()` does not settle until the whole body has gone out, so a
 * fixed cap is really a bandwidth floor: a few megabytes of audio on a slow
 * uplink times out every time. `bytesPerMs` is deliberately slower than any
 * link worth waiting for, which keeps the deadline a stall detector rather than
 * a speed limit.
 */
export const deadlineFor = (base, bytes, bytesPerMs) => base + Math.ceil((bytes || 0) / bytesPerMs);
