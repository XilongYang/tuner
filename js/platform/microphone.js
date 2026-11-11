// One microphone, held by one thing at a time.
//
// The player's rule for sound coming out -- one clip at a time, owned
// centrally -- applied to sound going in. A sentence's take and a word's retest
// both record, and before this each kept a recorder of its own and told the
// other about it through callbacks: "is the row recording", "a retest is
// busy", a flag per row that had to be set and cleared by hand. Two state
// machines negotiating is how one of them ends up stuck -- a retest whose
// start was abandoned left its row's controls disabled for good.
//
// Here the microphone is a single holder. Whoever wants it asks for a handle in
// its own name, and the handle is recorder-shaped (`start`, `stop`,
// `isRecording`) so the commands that take a recorder take this instead and
// know nothing about ownership. Starting while someone else holds it is refused
// rather than queued, which the commands already report as "already
// recording"; releasing is one call that lets go of whoever holds it, which is
// what leaving a session needs. Who holds it is announced, so every row can
// read its own controls from the one fact rather than from a flag of its own.

import { createRecorder as createPlatformRecorder } from './recorder.js';

/**
 * @typedef {object} Microphone
 * @property {() => string|null} owner
 * @property {(owner: string) => boolean} isHeldBy
 * @property {(listener: (owner: string|null) => void) => () => void} subscribe
 * @property {(owner: string) => {isRecording: boolean, start: () => Promise<boolean>, stop: () => Promise<object|null>}} for
 * @property {(owner?: string|null) => void} release
 */

/**
 * @param {object} [deps]
 * @param {() => object} [deps.createRecorder] A fresh recorder per take; the
 *   platform's by default, a fake in tests.
 */
export function createMicrophone({ createRecorder = createPlatformRecorder } = {}) {
  /** @type {{owner: string, recorder: object}|null} */
  let held = null;
  const listeners = new Set();

  const announce = () => {
    for (const listener of [...listeners]) listener(held?.owner ?? null);
  };

  /** Let go of `entry`, if it is still the one held. A later holder is left alone. */
  function drop(entry) {
    if (held !== entry) return;
    held = null;
    announce();
  }

  return {
    /** Who holds the microphone, or null. Held from the moment `start` is called, not from when the take begins. */
    owner: () => held?.owner ?? null,
    isHeldBy: (owner) => held !== null && held.owner === owner,

    /** Called with the new owner (or null) whenever the microphone changes hands. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * A recorder-shaped handle in `owner`'s name.
     *
     * `start()` takes the microphone, or returns false when something else
     * holds it -- the same answer a recorder gives when asked to start twice,
     * so a command reports it the same way. `stop()` returns the take, or null
     * when this owner was not recording. Both let go of the microphone when
     * they are done, including when they fail: a handle never keeps what its
     * own call did not finish with.
     */
    for(owner) {
      return {
        get isRecording() {
          return held !== null && held.owner === owner && Boolean(held.recorder.isRecording);
        },

        async start() {
          if (held) return false;
          const recorder = createRecorder();
          const entry = { owner, recorder };
          held = entry;
          announce();
          try {
            const started = await recorder.start();
            // Released while the permission prompt was up -- the session was
            // left, say. The recorder has been disposed already and refused to
            // finish starting; this only reports it.
            if (!started || held !== entry) {
              recorder.dispose();
              drop(entry);
              return false;
            }
            return true;
          } catch (err) {
            recorder.dispose();
            drop(entry);
            throw err;
          }
        },

        async stop() {
          if (!held || held.owner !== owner) return null;
          const entry = held;
          try {
            return await entry.recorder.stop();
          } finally {
            // A stop that throws has still given the recorder up; disposing
            // here is what keeps a failed device from holding the microphone
            // for the life of the page.
            entry.recorder.dispose();
            drop(entry);
          }
        },
      };
    },

    /**
     * Let go of the microphone, discarding any take in progress.
     *
     * With an `owner`, only if that owner holds it -- a popover closing must not
     * stop the row's own take. Without one, whoever holds it: the workspace is
     * being released.
     */
    release(owner = null) {
      if (!held) return;
      if (owner !== null && held.owner !== owner) return;
      const entry = held;
      held = null;
      entry.recorder.dispose();
      announce();
    },
  };
}
