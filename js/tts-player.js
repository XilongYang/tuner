// Reference TTS playback: a single-clip audio player (mutual exclusion
// between Speak/Playback buttons) plus an in-memory cache of synthesized
// audio so repeating Speak on the same text/voice doesn't re-request Azure.

import { synthesizeAzure } from './tts.js';
import { getVoice, loadCredentials } from './config.js';
import { transcribe } from './sentence-panel/audio-import.js';

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
    entry = { blob, url: URL.createObjectURL(blob), _wordsPromise: null };
    ttsCache.set(key, entry);
  }
  return entry;
}

/**
 * Re-transcribe a synthesized TTS clip via Azure Fast Transcription (the same
 * call audio-import.js's transcribe() makes for a real uploaded file) to
 * recover real word-level timestamps for it -- the same shape as an imported
 * sentence's sentence.words[] ({ offsetMilliseconds, durationMilliseconds,
 * charStart, charEnd }), except relative to `text` itself.
 *
 * Trust boundary: since we chose `text`, not Azure, we never adopt whatever
 * text Azure claims to have heard back -- only its timing, and only for
 * whichever of Azure's own words we can confidently locate in `text` (see
 * matchWordsToText() below). No global "the whole clip matched or it
 * didn't" requirement any more -- one word Azure misheard, or a comma it
 * didn't voice, no longer costs every OTHER word in the sentence its
 * triangle too.
 */
async function alignWordsForClip(blob, text, lang) {
  const creds = loadCredentials();
  // Fast Transcription needs the resource name (custom subdomain) specifically
  // -- see audio-import.js's handleAudioImport() for the same requirement.
  // Speak/TTS itself only ever needed key+region, so this is silently absent
  // for anyone who set up Speak before this feature existed -- logged (not
  // surfaced as a UI error, since Speak must keep working without it) so it's
  // at least visible in devtools instead of failing with no trace at all.
  if (!creds || !creds.resourceName) {
    console.warn('[tts-align] skipped: no Azure resource name (custom subdomain) configured -- set it in Azure settings to enable exact-boundary triangles/highlight.');
    return null;
  }
  let result;
  try {
    result = await transcribe(blob, creds);
  } catch (err) {
    console.warn('[tts-align] Fast Transcription request failed, no exact triangles for this clip:', err);
    return null; // best-effort only: never break Speak/Export over this.
  }
  return matchWordsToText((result && result.phrases) || [], text, lang);
}

// Trims leading/trailing punctuation, whitespace, and any other non-letter/
// non-number characters from an ASR word's own text, so a comma, a paren,
// a "~", or ITN-added punctuation Azure attached to a word never has to
// literally appear in `text` for that word to still be found there --
// matchWordsToText() below never compares punctuation at all, only this
// alphanumeric core. \p{L}/\p{N} are Unicode-aware, so this works the same
// for Japanese kana/kanji as for English letters/digits.
const WORD_CORE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
function wordCore(raw) {
  return raw.replace(WORD_CORE, '');
}

// A run of ASCII digits with optional internal grouping punctuation --
// "18,000", "1.500".
const DIGIT_GROUP_RUN = /[0-9][0-9,.]*/g;

/**
 * Locate `core`'s next occurrence in `text` at or after `cursor`. Tries a
 * plain case-insensitive substring search first -- this alone already
 * handles Azure splitting a number into several word tokens ("18,000" as
 * "18" + "000": each is directly, literally a substring of "18,000",
 * comma and all, wherever it starts scanning from).
 *
 * Only when that fails AND `core` is purely digits does this fall back to
 * scanning `text` for a run of digits that may carry grouping punctuation
 * Azure's ITN stripped when transcribing the clip back (our "18,000" vs a
 * single merged word.text "18000" -- a plain substring search for "18000"
 * can't find it inside "18,000" at all, since the comma breaks the digits'
 * contiguity, unlike the split case above). Only ever strips punctuation
 * that sits BETWEEN digits of a number being compared to another number,
 * never anything else -- this doesn't get anywhere near the general "ignore
 * all punctuation" territory a whole-string normalization pass would, it's
 * specifically the one place TTS-then-ASR reliably reformats text (digit
 * grouping) instead of just failing to voice something.
 * @returns {{start: number, end: number}|null}
 */
function findCore(text, cursor, core) {
  const foundAt = text.toLowerCase().indexOf(core.toLowerCase(), cursor);
  if (foundAt !== -1) return { start: foundAt, end: foundAt + core.length };
  if (/^[0-9]+$/.test(core)) {
    DIGIT_GROUP_RUN.lastIndex = cursor;
    let m;
    while ((m = DIGIT_GROUP_RUN.exec(text))) {
      const digitsOnly = m[0].replace(/[^0-9]/g, '');
      if (digitsOnly === core) return { start: m.index, end: m.index + m[0].length };
      DIGIT_GROUP_RUN.lastIndex = m.index + 1; // keep scanning forward, don't just take the first digit run
    }
  }
  return null;
}

/**
 * The pure alignment half of alignWordsForClip() above, split out so it's
 * testable without a real Azure round trip (feed it a Fast
 * Transcription-shaped `phrases` array directly).
 *
 * Word-by-word, not a single whole-string comparison: walks Azure's own
 * words in order and, for each one, searches `text` for that word's
 * punctuation-stripped core (case-insensitively), starting from just past
 * wherever the previous word was found -- never backtracking, since both
 * sides are the same speech in the same order. A word that can't be found
 * from there (Azure misheard it, or restructured it enough that its core
 * text doesn't appear verbatim -- "18,000" transcribed as "18" + "000", or
 * merged into one "18000" token, are both still found via findCore()'s
 * digit-grouping-aware matching below, but "eighteen thousand" wouldn't be)
 * is simply skipped -- no timestamp for that one word, not a reason to
 * discard every other word's. This is why punctuation differences (a comma
 * TTS didn't voice, an ITN-added period, a dropped "~") no longer matter at
 * all: they were never part of what's being matched, only the words are.
 * @param {Array} phrases Fast Transcription's own `result.phrases`.
 * @param {string} text The sentence text TTS was asked to say.
 * @param {'ja'|'en'} lang Unused now that punctuation/spacing reconstruction
 *   is gone, but kept for signature stability with alignWordsForClip()'s call.
 * @returns {Array|null}
 */
export function matchWordsToText(phrases, text, lang) {
  const asrWords = [];
  for (const phrase of phrases) {
    for (const w of phrase.words || []) {
      if (w.text) asrWords.push(w);
    }
  }
  if (!asrWords.length) {
    console.warn('[tts-align] Azure returned no word-level data for this clip, no exact triangles for this sentence:', { text });
    return null;
  }

  const words = [];
  const skipped = [];
  let cursor = 0;
  for (const w of asrWords) {
    const core = wordCore(w.text);
    if (!core) continue; // Azure "word" was pure punctuation -- nothing to locate
    const found = findCore(text, cursor, core);
    if (!found) {
      skipped.push(w.text); // couldn't find this one from here on -- skip just this word
      continue;
    }
    words.push({
      offsetMilliseconds: w.offsetMilliseconds,
      durationMilliseconds: w.durationMilliseconds,
      charStart: found.start,
      charEnd: found.end,
    });
    cursor = found.end;
  }
  if (!words.length) {
    console.warn('[tts-align] None of Azure\'s words could be located in the original text, no exact triangles for this sentence:', { text });
    return null;
  }
  // Partial coverage is normal and fine (see this function's doc comment) --
  // logged at the same non-blocking console.warn level as a total failure,
  // just so a gap in the triangles is traceable to which specific ASR
  // word(s) didn't locate, instead of only ever being visible as "nothing
  // logged, some words just have no triangle."
  if (skipped.length) {
    console.warn(`[tts-align] ${skipped.length}/${asrWords.length} of Azure's words couldn't be located in the original text (no triangle for those, the rest are fine):`,
      { text, skipped });
  }
  return words;
}

/**
 * Lazily kick off alignWordsForClip() for a getTtsEntry() result and memoize
 * the promise on the entry itself, so repeat callers (Speak, a later Export)
 * share one in-flight/completed alignment instead of re-transcribing on every
 * click -- and a caller that never needs words (e.g. assessment.js's
 * single-word Retest playback) never triggers the extra Azure call at all,
 * since this is opt-in per call site rather than folded into getTtsEntry()
 * itself. Always resolves (never rejects); resolves to null when there's
 * nothing usable.
 * @returns {Promise<Array|null>}
 */
export function ensureTtsWords(entry, text, lang) {
  if (!entry._wordsPromise) {
    entry._wordsPromise = alignWordsForClip(entry.blob, text, lang).catch(() => null);
  }
  return entry._wordsPromise;
}
