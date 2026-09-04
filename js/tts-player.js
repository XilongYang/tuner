// Reference TTS playback: a single-clip audio player (mutual exclusion
// between Speak/Playback buttons) plus an in-memory cache of synthesized
// audio so repeating Speak on the same text/voice doesn't re-request Azure.

import { synthesizeAzure } from './tts.js';
import { getVoice } from './config.js';

// Reusable audio element for TTS playback
export const ttsAudio = new Audio();

// Global playback controller: only one clip plays at a time. Marks the triggering
// button active while it plays, and enforces mutual exclusion across Speak / Playback.
export const player = {
  audio: null,
  button: null,
  _onEnded: null,
  /** Stop the current playback (if any) and clear its active button. */
  stop() {
    if (this.audio) {
      if (this._onEnded) this.audio.removeEventListener('ended', this._onEnded);
      this.audio.pause();
      this.audio = null;
      this._onEnded = null;
    }
    if (this.button) {
      this.button.classList.remove('is-playing');
      this.button = null;
    }
    // Also stop the browser speechSynthesis fallback, if any is speaking.
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  },
  /** Start playing `audio`, marking `button` active; stops whatever was playing first. */
  start(audio, button) {
    this.stop();
    this.audio = audio;
    this.button = button;
    if (button) button.classList.add('is-playing');
    this._onEnded = () => this.stop();
    audio.addEventListener('ended', this._onEnded);
    return audio.play();
  },
  /** Whether `button` is the one currently playing. */
  isActive(button) {
    return this.button === button && !!this.audio;
  },
};

// In-memory cache of synthesized TTS audio, keyed by a hash of voice + text, so
// repeating Speak on the same text and voice doesn't re-request Azure. Values are
// { blob, url }; kept for the session (cleared on reload).
const ttsCache = new Map();

/** Build a cache key: SHA-256 hex of "voice + text" (falls back to the raw string). */
async function ttsCacheKey(voice, text) {
  const raw = voice + '\n' + text;
  if (window.crypto && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return raw;
}

/**
 * Get the reference TTS audio for text/locale, from cache or by synthesizing.
 * Requires Azure credentials. `onMiss` (optional) runs just before a network fetch.
 * @returns {Promise<{ blob: Blob, url: string }>}
 */
export async function getTtsEntry(text, locale, onMiss) {
  const key = await ttsCacheKey(getVoice(locale), text);
  let entry = ttsCache.get(key);
  if (!entry) {
    if (onMiss) onMiss();
    const blob = await synthesizeAzure(text, locale);
    entry = { blob, url: URL.createObjectURL(blob) };
    ttsCache.set(key, entry);
  }
  return entry;
}
