// Turning a speech-to-text result into practice sentences.
//
// A transcription service segments by pause, which regularly lands mid-sentence.
// This re-segments by punctuation instead -- the same rule typed text is split
// by (./text.js) -- and gives each resulting sentence an audio range derived
// from the words it actually contains, so every sentence can be sliced from the
// original file losslessly.
//
// Pure: the input is plain data normalised at the cloud boundary, and the output
// is plain data. Nothing here decodes or cuts audio; platform/audio.js does that
// with the ranges computed here.

import { segmentText } from './text.js';
import { chars } from './geometry.js';

/**
 * Margin restored to each side of a re-segmented sentence's range.
 *
 * A word's own timings are tighter than the pause-based boundaries they came
 * from and clip the leading and trailing edge of speech. The margin is bounded
 * by half the real silence to the neighbouring word on that side, so two
 * adjacent sentences padding toward each other meet in the middle of the gap
 * and never overlap -- an unbounded margin pulls a piece of the neighbouring
 * sentence into the clip, which is plainly audible.
 */
export const PAD_MS = 120;

/** @typedef {{text: string, offsetMs: number, durationMs: number}} SpokenWord */
/** @typedef {{text: string, lang: string, words?: SpokenWord[]}} Phrase */

const isJapanese = (lang) => lang === 'ja';

/**
 * Flatten every phrase's words into one chronological list while rebuilding the
 * transcript they spell out, recording which character range of it each word
 * occupies.
 *
 * Those ranges are the whole point: they let a punctuation split of the rebuilt
 * text be mapped straight back to audio timings, with no fuzzy matching of
 * sentence text against words afterwards.
 *
 * A phrase break becomes a real space regardless of language. That matters even
 * between two Japanese phrases, and it is essential when a phrase ends in an
 * ASCII period: a period only terminates a sentence when whitespace follows it,
 * so gluing the next phrase directly on would hide the boundary entirely.
 *
 * @param {Phrase[]} phrases
 */
export function buildWordTimeline(phrases) {
  const words = [];
  let text = '';
  const needsSpace = () => text.length > 0 && !/\s$/.test(text);

  for (const phrase of phrases || []) {
    const lang = phrase.lang;
    if (needsSpace()) text += ' ';
    for (const word of phrase.words || []) {
      if (!word.text) continue;
      // Within a phrase, Japanese runs together; everything else is spaced.
      if (!isJapanese(lang) && needsSpace()) text += ' ';
      const start = chars(text).length;
      text += word.text;
      words.push({
        offsetMs: word.offsetMs,
        durationMs: word.durationMs,
        lang,
        start,
        end: chars(text).length,
      });
    }
  }
  return { text, words };
}

/**
 * Widen a range by up to `padMs` on each side, bounded by half the silence to
 * the neighbouring word and by the file's own extent.
 *
 * `prevEndMs`/`nextStartMs` are null where there is no neighbour, which means
 * the full margin is available on that side.
 *
 * @returns {{offsetMs: number, durationMs: number}}
 */
export function padBounds({ startMs, endMs, prevEndMs = null, nextStartMs = null, padMs = PAD_MS, totalDurationMs = null }) {
  const leftGap = prevEndMs == null ? Infinity : Math.max(0, startMs - prevEndMs);
  const rightGap = nextStartMs == null ? Infinity : Math.max(0, nextStartMs - endMs);

  const paddedStart = Math.max(0, startMs - Math.min(padMs, leftGap / 2));
  const paddedEndRaw = endMs + Math.min(padMs, rightGap / 2);
  const paddedEnd = totalDurationMs == null ? paddedEndRaw : Math.min(totalDurationMs, paddedEndRaw);

  return { offsetMs: paddedStart, durationMs: Math.max(0, paddedEnd - paddedStart) };
}

/**
 * Re-segment a transcription result into sentences with audio ranges and
 * per-word positions.
 *
 * Returns [] when there is no word-level timing to align against; the caller
 * then falls back to the service's own phrase boundaries, which at least carry
 * ranges even though they segment worse.
 *
 * @param {Phrase[]} phrases
 * @param {number|null} totalDurationMs Extent of the source file, if known.
 * @returns {Array<{text: string, lang: string, offsetMs: number, durationMs: number, words: Array<{charStart: number, charEnd: number, offsetMs: number, durationMs: number}>}>}
 */
export function resegment(phrases, totalDurationMs = null) {
  const { text, words } = buildWordTimeline(phrases);
  if (!text.trim() || !words.length) return [];

  const segments = [];
  // Each sentence's position in the rebuilt transcript is found by walking
  // forward through it, so a sentence that happens to repeat earlier text still
  // maps to its own occurrence.
  const all = chars(text);
  let cursor = 0;

  for (const sentence of segmentText(text)) {
    const span = findSpan(all, sentence, cursor);
    if (!span) continue;
    cursor = span.end;

    const indices = wordIndicesIn(words, span.start, span.end);
    if (!indices.length) continue;

    const first = words[indices[0]];
    const last = words[indices[indices.length - 1]];
    const prev = indices[0] > 0 ? words[indices[0] - 1] : null;
    const next = indices[indices.length - 1] < words.length - 1 ? words[indices[indices.length - 1] + 1] : null;

    const { offsetMs, durationMs } = padBounds({
      startMs: first.offsetMs,
      endMs: last.offsetMs + last.durationMs,
      prevEndMs: prev ? prev.offsetMs + prev.durationMs : null,
      nextStartMs: next ? next.offsetMs : null,
      totalDurationMs,
    });

    const japanese = indices.filter((i) => isJapanese(words[i].lang)).length;
    segments.push({
      text: sentence,
      // A sentence can span a language change; the majority of its words
      // decides, since one label has to cover the whole sentence.
      lang: japanese * 2 >= indices.length ? 'ja' : 'en',
      offsetMs,
      durationMs,
      // Each word's position within THIS sentence, so the split UI can offer a
      // cut at every real word boundary instead of guessing from character
      // ratios. Clamped, since a word can straddle the punctuation that ended
      // the sentence by a character.
      words: indices.map((i) => ({
        charStart: clamp(words[i].start - span.start, 0, sentence.length),
        charEnd: clamp(words[i].end - span.start, 0, sentence.length),
        offsetMs: words[i].offsetMs,
        durationMs: words[i].durationMs,
      })),
    });
  }

  return segments;
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Where `sentence` sits in the transcript, searching from `from` onward. */
function findSpan(allChars, sentence, from) {
  const needle = chars(sentence);
  for (let start = from; start + needle.length <= allChars.length; start++) {
    let match = true;
    for (let i = 0; i < needle.length; i++) {
      if (allChars[start + i] !== needle[i]) { match = false; break; }
    }
    if (match) return { start, end: start + needle.length };
  }
  return null;
}

/** Indices of words overlapping [start, end), in timeline order. */
function wordIndicesIn(words, start, end) {
  const indices = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i].start < end && words[i].end > start) indices.push(i);
  }
  return indices;
}

/**
 * The word being spoken at `ms`, on the same timeline the words carry.
 *
 * Used to follow a reading along the text. Returns null between words and
 * outside the sentence entirely -- silence is a real answer here, and a caller
 * that highlighted the nearest word instead would leave one lit through every
 * pause.
 *
 * The search is linear because a sentence has a handful of words; nothing here
 * justifies a binary search that could be wrong at the boundaries.
 *
 * @param {{charStart: number, charEnd: number, offsetMs: number, durationMs: number}[]} words
 * @param {number} ms
 */
export function wordAt(words, ms) {
  if (!words?.length || ms == null) return null;
  return words.find((word) => (
    word.offsetMs != null
    && word.durationMs != null
    && ms >= word.offsetMs
    && ms < word.offsetMs + word.durationMs
  )) || null;
}

// The alphanumeric core of a transcribed word: leading and trailing punctuation
// removed. Punctuation is never compared -- a comma the reading did not voice,
// a period the transcriber added, a tilde it dropped -- only the letters and
// digits are, and \p{L}/\p{N} make that work the same for kana and kanji as for
// Latin letters.
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * The text reduced to its letters and digits, lowercased, with a way back.
 *
 * Matching happens on this rather than on the text itself, because a reading
 * and the text it was read from agree about letters and about nothing else.
 * "18,000" comes back as the single token "18000"; "A B C D E" comes back as
 * "ABCDE"; "don't" may come back as "dont". None of those is a substring of
 * the original, and all of them are the same letters in the same order.
 *
 * `index[i]` is where the i-th kept character sits in the original, which is
 * what turns a match back into a span of the text.
 */
function project(text) {
  let flat = '';
  const index = [];
  for (let i = 0; i < text.length; i += 1) {
    if (!LETTER_OR_DIGIT.test(text[i])) continue;
    flat += text[i].toLowerCase();
    index.push(i);
  }
  return { flat, index };
}

/** A spoken token reduced the same way, so the two can be compared at all. */
const core = (token) => [...token].filter((ch) => LETTER_OR_DIGIT.test(ch)).join('').toLowerCase();

export function alignWordsToText(phrases, text) {
  if (!text) return null;

  const spoken = [];
  for (const phrase of phrases || []) {
    for (const word of phrase.words || []) if (word.text) spoken.push(word);
  }

  const { flat, index } = project(text);
  const words = [];
  // In the projection, not in the text: the cursor is what stops a repeated
  // word from matching the earlier one again, and it has to advance in the
  // same space the search happens in.
  let cursor = 0;

  for (const word of spoken) {
    const wanted = core(word.text);
    if (!wanted) continue;
    const at = flat.indexOf(wanted, cursor);
    if (at === -1) continue;
    words.push({
      // The span covers everything between the first and last letter matched,
      // punctuation and spaces included. A token that ran several of the
      // text's words together -- "ABCDE" for "A B C D E" -- therefore spans
      // all of them, which is what the reading actually timed.
      charStart: index[at],
      charEnd: index[at + wanted.length - 1] + 1,
      offsetMs: word.offsetMs ?? null,
      durationMs: word.durationMs ?? null,
    });
    cursor = at + wanted.length;
  }

  return words.length ? words : null;
}

