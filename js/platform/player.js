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
 */
export function createPlayer(deps = {}) {
  const {
    createAudio = (url) => new Audio(url),
    createObjectUrl = (blob) => URL.createObjectURL(blob),
    revokeObjectUrl = (url) => URL.revokeObjectURL(url),
  } = deps;

  let audio = null;
  let url = null;
  let token = null;
  const listeners = new Set();

  const announce = () => {
    for (const listener of [...listeners]) listener(token);
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
      if (!audio && token === null) return;
      release();
      token = null;
      announce();
    },
  };
}
