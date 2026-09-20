// The browser's own voice, used when there is no Azure key.
//
// It is a fallback and nothing more: the voices are noticeably flatter, and --
// the part that matters to the rest of the app -- it produces no audio, only
// sound. There is no clip to keep, so nothing is stored on the sentence, no
// hash is taken, nothing syncs, and a pronunciation score is still impossible.
// Everything downstream of Speak therefore has to work with no reference at
// all, which it already does for an imported sentence whose clip could not be
// cut.
//
// Wrapped rather than called at its use site for the usual reason: it is a
// browser API with a callback shape, global cancel semantics and a voice list
// that arrives late, and putting it behind a promise here is what lets the
// command layer be tested without a speech engine.

/**
 * @param {Window} [win] Injected so tests can pass a stand-in; the real one
 *   defaults to this browser.
 * @param {object} [options]
 * @param {number} [options.startTimeoutMs] How long to wait for the engine to
 *   start before giving up on it. Injected so the giving-up path can be tested
 *   without five seconds of waiting.
 */
export function browserSpeech(win = globalThis, { startTimeoutMs = 5000 } = {}) {
  const engine = () => win?.speechSynthesis ?? null;
  const Utterance = () => win?.SpeechSynthesisUtterance ?? null;

  // Chrome populates the voice list asynchronously and answers getVoices() with
  // [] until it has. Asking once at startup is what prompts it, and the event
  // is where the answer arrives; by the time anyone presses Speak it is there.
  try {
    engine()?.getVoices?.();
    engine()?.addEventListener?.('voiceschanged', () => { engine()?.getVoices?.(); });
  } catch { /* an engine that refuses to be asked is simply unavailable */ }

  return {
    /**
     * Whether this browser can actually speak.
     *
     * Having the API is not enough: a headless browser, and some Linux
     * installations without a speech engine, expose it with an empty voice list
     * and then neither speak nor report an error -- the sentence would sit
     * "preparing" for ever. A voice has to exist.
     */
    available() {
      const synthesis = engine();
      if (!synthesis || !Utterance()) return false;
      try {
        return (synthesis.getVoices?.() ?? []).length > 0;
      } catch {
        return false;
      }
    },

    /**
     * Speak `text` in `locale`, replacing anything it was already saying.
     *
     * Resolves when the reading STARTS, not when it ends: that is the moment
     * the caller is waiting on -- the same point the Azure path returns at,
     * once playback has begun -- and holding the sentence's controls disabled
     * for the length of a reading serves nobody. Rejects when the engine
     * reports a failure, or when it never starts at all.
     */
    speak(text, locale) {
      const synthesis = engine();
      const Speech = Utterance();
      if (!synthesis || !Speech) return Promise.reject(new Error('This browser has no built-in voice.'));

      // One voice at a time, for the same reason the player allows one clip:
      // two readings over each other are never what was wanted.
      synthesis.cancel();

      return new Promise((resolve, reject) => {
        const utterance = new Speech(text);
        utterance.lang = locale;

        const timer = setTimeout(() => {
          synthesis.cancel();
          reject(new Error('The browser\'s built-in voice did not respond.'));
        }, startTimeoutMs);

        const settle = (fn) => (...args) => { clearTimeout(timer); fn(...args); };
        utterance.onstart = settle(() => resolve());
        utterance.onerror = settle(() => reject(new Error('The browser\'s built-in voice failed.')));
        // An engine that finishes without ever starting still has to settle
        // this, or the caller waits on a reading that already happened.
        utterance.onend = settle(() => resolve());

        synthesis.speak(utterance);
      });
    },

    /** Stop mid-sentence. Safe when nothing is being said. */
    cancel() {
      try {
        engine()?.cancel();
      } catch { /* nothing to stop */ }
    },
  };
}
