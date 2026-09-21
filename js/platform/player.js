// Playback of one clip at a time, and the object URLs that go with it.
//
// One player for the whole app, because that is the actual requirement: hearing
// the reference while your own take is still playing is never wanted, and
// clicking a second play button should stop the first. Owning that centrally is
// what makes "clicking the playing button stops it" a property of the player
// rather than something every button reimplements.
//
// The player also owns every object URL it creates and revokes each one when
// its audio is finished with. That is deliberate: URLs created ad hoc at call
// sites are what previously accumulated -- each one pinning its Blob in memory
// for the life of the tab -- because the code that created them had no obvious
// moment to release them.

/**
 * @param {object} [deps]
 * @param {(url: string) => HTMLAudioElement} [deps.createAudio]
 * @param {(blob: Blob) => string} [deps.createObjectUrl]
 * @param {(url: string) => void} [deps.revokeObjectUrl]
 * @param {() => void} [deps.silenceOthers] Called before playback starts and
 *   when it stops. "One sound at a time" is this module's own rule, and the
 *   browser's built-in voice is a second source of sound it cannot see -- it
 *   speaks through the speech engine, not through an audio element. Handing
 *   the player a way to silence that keeps the rule in one place instead of
 *   wrapping the player at the composition root, where it was behaviour with
 *   no test on it.
 */
export function createPlayer(deps = {}) {
  const {
    createAudio = (url) => new Audio(url),
    createObjectUrl = (blob) => URL.createObjectURL(blob),
    revokeObjectUrl = (url) => URL.revokeObjectURL(url),
    silenceOthers = () => {},
  } = deps;

  let audio = null;
  let url = null;
  let token = null;
  const listeners = new Set();
  const timeListeners = new Set();

  const announce = () => {
    for (const listener of [...listeners]) listener(token);
  };

  // Kept apart from `announce`: buttons care when playback starts and stops,
  // following a reading along the text cares four times a second, and mixing
  // the two would repaint every button on every tick.
  const announceTime = (elapsedMs) => {
    for (const listener of [...timeListeners]) listener(token, elapsedMs);
  };

  function release() {
    if (audio) {
      try { audio.pause(); } catch { /* already stopped */ }
      audio.onended = null;
      audio.onerror = null;
      audio = null;
    }
    if (url) {
      revokeObjectUrl(url);
      url = null;
    }
  }

  return {
    /** What is playing, identified by whatever the caller passed as `token`. */
    current: () => token,
    isPlaying: (candidate) => token !== null && token === candidate,

    /** Called whenever playback starts or stops, so buttons can show their state. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Called as playback advances, with the token and how far in it is, in ms.
     * Returns an unsubscribe function, which a row that goes away must call.
     */
    onTime(listener) {
      timeListeners.add(listener);
      return () => timeListeners.delete(listener);
    },

    /**
     * Play `blob`, replacing anything already playing.
     *
     * `token` identifies the source for `isPlaying` -- typically the element or
     * id that asked for it. Playing the token that is already playing stops it
     * instead, which is what makes one button both start and stop.
     *
     * @returns {Promise<boolean>} true when playback started, false when the
     *   call stopped what was playing, or the clip could not be played.
     */
    async play(blob, nextToken = null) {
      silenceOthers();
      if (nextToken !== null && token === nextToken) {
        this.stop();
        return false;
      }
      release();

      token = nextToken;
      url = createObjectUrl(blob);
      audio = createAudio(url);

      // Both endings release: without the error path, a clip the browser cannot
      // decode would leave its URL -- and its Blob -- held forever.
      audio.onended = () => { release(); token = null; announce(); };
      audio.onerror = () => { release(); token = null; announce(); };
      // The browser's own progress events: roughly four a second, which is what
      // the old implementation followed a reading with and is accurate enough
      // for it. Nothing here polls.
      audio.ontimeupdate = () => announceTime((audio?.currentTime ?? 0) * 1000);

      announce();
      try {
        await audio.play?.();
        return true;
      } catch {
        // Autoplay refusal, or an unplayable clip. Reported by returning false
        // rather than thrown: the caller shows its own message, and nothing is
        // left holding a URL either way.
        release();
        token = null;
        announce();
        return false;
      }
    },

    /** Stop and release. Safe at any time. */
    stop() {
      silenceOthers();
      if (!audio && token === null) return;
      release();
      token = null;
      announce();
    },
  };
}
