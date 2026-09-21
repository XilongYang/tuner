// Split/merge geometry: where a sentence can be cut, how its word timings and
// manual cut points divide, and how an audio range divides with them.
//
// Pure arithmetic over plain values. Nothing here reads app state, touches the
// DOM, or decodes audio -- the actual re-slicing of samples lives in
// platform/audio.js and takes the ranges this module computes. That separation
// is what makes the app's most intricate logic testable with object literals.
//
// Timestamps are `number | null` throughout, and null is load-bearing: it means
// "there is no timestamp at this position", which is a different fact from 0
// (the very start of the source audio). Conflating them silently produced
// empty clips before, because a missing timestamp arrived as 0 and the
// arithmetic accepted it as real. Functions here therefore take `ms` values
// as-is and check for null explicitly; they never coerce.
//
// A word is `{ charStart, charEnd, offsetMs, durationMs }` -- char offsets into
// the sentence's own text (code points, not UTF-16 units), and milliseconds on
// the ORIGINAL source audio's timeline, not relative to the sentence's clip.
// Speech-service field names are mapped to these at the cloud boundary, so no
// vendor naming leaks past it.

import { canCutBetween } from './text.js';

/** @typedef {{ charStart: number, charEnd: number, offsetMs: number, durationMs: number }} Word */
/** @typedef {{ charIndex: number, offsetMs: number|null }} ManualPoint */
/** @typedef {{ charIndex: number, ms: number|null, kind: 'word'|'manual'|'text' }} SplitPoint */
/** @typedef {{ offsetMs: number, durationMs: number }} Range */

/** Code points, so a split index never lands inside a surrogate pair. */
export const chars = (text) => Array.from(text || '');

/**
 * Whether the practice text box is locked: always for an audio-imported
 * session, and for a typed one once it has actually been split (a fresh 'auto'
 * session has no sentences yet and must stay editable).
 *
 * Takes its inputs rather than reading them, so it is usable from both the
 * renderer and the command layer without either importing the other, and is
 * testable on its own.
 */
export function isSessionLocked(splitMode, sentenceCount) {
  return splitMode === 'audio' || (splitMode === 'auto' && sentenceCount > 0);
}

/**
 * Synthetic cut points for a sentence with no timing data at all: the positions
 * where a cut can legitimately fall, minus the ends. `ms` is null for all of
 * them -- there is no audio timeline information to offer, and saying so is
 * the point.
 *
 * Which positions those are is a question about writing, not about geometry,
 * so canCutBetween answers it: every character gap in Japanese, word starts
 * only in English.
 * @returns {SplitPoint[]}
 */
export function textSplitPoints(text) {
  const cs = chars(text);
  const points = [];
  for (let i = 1; i < cs.length; i++) {
    if (canCutBetween(cs[i - 1], cs[i])) points.push({ charIndex: i, ms: null, kind: 'text' });
  }
  return points;
}

/**
 * The pickable word units of a sentence, in order.
 *
 * Real word spans when the sentence has them -- those carry their own timings,
 * which is what lets a picked phrase be cut out of the source audio rather
 * than synthesised. Without them the units come from textSplitPoints(), so a
 * sentence that has never been spoken can still be picked from, and so the
 * question "where does a word begin" is answered in exactly one place for
 * both cutting and picking.
 *
 * Whitespace between units is not part of any of them: it is not pickable, and
 * a unit that carried it would put a leading space in a vocabulary entry.
 *
 * @returns {Array<{charStart: number, charEnd: number, offsetMs: number|null, durationMs: number|null}>}
 */
export function wordUnits(sentence) {
  if (sentence?.words?.length) return sentence.words;

  const cs = chars(sentence?.text);
  const bounds = [0, ...textSplitPoints(sentence?.text || '').map((p) => p.charIndex), cs.length];
  const units = [];
  for (let i = 1; i < bounds.length; i += 1) {
    let start = bounds[i - 1];
    let end = bounds[i];
    while (start < end && /\s/u.test(cs[start])) start += 1;
    while (end > start && /\s/u.test(cs[end - 1])) end -= 1;
    if (start < end) units.push({ charStart: start, charEnd: end, offsetMs: null, durationMs: null });
  }
  return units;
}

/**
 * Selected unit indices, grouped into runs of consecutive ones.
 *
 * Two units next to each other in the sequence are one phrase, whatever stands
 * between them in the text -- a space in English, nothing at all in Japanese.
 * Two that are not become separate entries. Adjacency is a fact about the word
 * sequence, so it is measured on indices rather than on characters.
 *
 * @param {Iterable<number>} indices
 * @returns {number[][]} ascending, each group ascending
 */
export function groupAdjacent(indices) {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const groups = [];
  for (const index of sorted) {
    const last = groups[groups.length - 1];
    if (last && index === last[last.length - 1] + 1) last.push(index);
    else groups.push([index]);
  }
  return groups;
}

/**
 * Every position this sentence can be cut at, ascending by charIndex.
 *
 * Real word boundaries and user-confirmed manual points are preferred; a
 * sentence with neither falls back to textSplitPoints() so that it still
 * offers cuts, just without audio timing. Positions at either end are dropped:
 * cutting there yields an empty half.
 * @returns {SplitPoint[]}
 */
export function splitPointers(sentence) {
  const len = chars(sentence.text).length;
  const inRange = (i) => i > 0 && i < len;
  const points = [];
  for (const w of sentence.words || []) {
    if (inRange(w.charStart)) points.push({ charIndex: w.charStart, ms: w.offsetMs ?? null, kind: 'word' });
  }
  for (const p of sentence.manualPoints || []) {
    if (inRange(p.charIndex)) points.push({ charIndex: p.charIndex, ms: p.offsetMs ?? null, kind: 'manual' });
  }

  // Word boundaries are the positions worth offering when there are any: they
  // are the only ones that can divide the audio, and adding the text's own
  // positions beside them would bury them. With no word timings there is no
  // such thing to bury, so the text's positions are offered -- even alongside a
  // seam left by a merge, which would otherwise be the single place a merged
  // sentence could be cut.
  if (!points.some((point) => point.kind === 'word')) {
    const taken = new Set(points.map((point) => point.charIndex));
    for (const point of textSplitPoints(sentence.text)) {
      if (!taken.has(point.charIndex)) points.push(point);
    }
  }

  points.sort((a, b) => a.charIndex - b.charIndex);
  return points;
}

/**
 * Split a sentence's text at `charIndex`, with no trimming on either side.
 *
 * The whitespace sitting at the cut stays on the left half rather than being
 * discarded, because merge rejoins texts with no separator of its own: a space
 * dropped here would be lost for good on the next split-then-merge.
 * @returns {{ left: string, right: string }}
 */
export function splitText(text, charIndex) {
  const cs = chars(text);
  return { left: cs.slice(0, charIndex).join(''), right: cs.slice(charIndex).join('') };
}

/** A cut is only meaningful if both halves contain something other than whitespace. */
export function isSplittable(text, charIndex) {
  const { left, right } = splitText(text, charIndex);
  return Boolean(left.trim()) && Boolean(right.trim());
}

/**
 * Divide a sentence's words across a cut at `charIndex`, re-basing the right
 * half's char offsets to its own new text.
 *
 * A word straddling the cut cannot occur: a word-kind cut is a word's own
 * charStart, and a text- or manual-kind cut falls in a gap no word occupies.
 * Anything straddling is therefore dropped rather than guessed at.
 * @returns {{ left: Word[], right: Word[] }}
 */
export function partitionWords(words, charIndex) {
  const left = [];
  const right = [];
  for (const w of words || []) {
    if (w.charEnd <= charIndex) left.push(w);
    else if (w.charStart >= charIndex) right.push({ ...w, charStart: w.charStart - charIndex, charEnd: w.charEnd - charIndex });
  }
  return { left, right };
}

/** The same division for manual cut points; the cut position itself is consumed by the split. */
export function partitionManualPoints(points, charIndex) {
  const left = [];
  const right = [];
  for (const p of points || []) {
    if (p.charIndex < charIndex) left.push(p);
    else if (p.charIndex > charIndex) right.push({ ...p, charIndex: p.charIndex - charIndex });
  }
  return { left, right };
}

/**
 * Divide an audio range at `splitMs`, both halves expressed on the original
 * source timeline so either can be re-sliced from it losslessly.
 *
 * Returns null when the range cannot be divided there, which is a normal
 * outcome, not an error: `splitMs` is null (a cut position with no timestamp),
 * or it falls outside the range so one half would be empty. Callers must treat
 * null as "this cut keeps no reference audio" and say so, rather than
 * proceeding as though audio had been produced.
 *
 * @param {Range} range
 * @param {number|null} splitMs  On the same timeline as `range.offsetMs`.
 * @returns {{ left: Range, right: Range }|null}
 */
export function splitRange(range, splitMs) {
  if (splitMs == null || !Number.isFinite(splitMs)) return null;
  if (!range || !Number.isFinite(range.offsetMs) || !Number.isFinite(range.durationMs)) return null;
  const endMs = range.offsetMs + range.durationMs;
  const leftDurationMs = splitMs - range.offsetMs;
  const rightDurationMs = endMs - splitMs;
  if (leftDurationMs <= 0 || rightDurationMs <= 0) return null;
  return {
    left: { offsetMs: range.offsetMs, durationMs: leftDurationMs },
    right: { offsetMs: splitMs, durationMs: rightDurationMs },
  };
}

/**
 * The single range covering a run of adjacent sentences, for merge.
 *
 * Returns null unless every one of them carries a range: a merge that can only
 * account for part of its audio has no honest result, so it keeps none and the
 * caller reports that instead of silently producing a clip missing a piece.
 * @param {Array<Range|null>} ranges
 * @returns {Range|null}
 */
export function mergeRanges(ranges) {
  if (!ranges || !ranges.length) return null;
  if (!ranges.every((r) => r && Number.isFinite(r.offsetMs) && Number.isFinite(r.durationMs))) return null;
  const start = Math.min(...ranges.map((r) => r.offsetMs));
  const end = Math.max(...ranges.map((r) => r.offsetMs + r.durationMs));
  if (end <= start) return null;
  return { offsetMs: start, durationMs: end - start };
}

/**
 * Words of a run of merged sentences, re-based onto the concatenated text.
 *
 * `texts[i]` must be the text the words of `wordLists[i]` are indexed against,
 * because merge concatenates with no separator: each list shifts by the total
 * length of everything before it. A run where any sentence has no words yields
 * null -- partial timings would put later words at wrong positions, which is
 * worse than having none.
 * @returns {Word[]|null}
 */
export function mergeWords(wordLists, texts) {
  if (!wordLists || !wordLists.length || wordLists.length !== texts.length) return null;
  if (!wordLists.every((list) => Array.isArray(list) && list.length)) return null;
  const out = [];
  let shift = 0;
  for (let i = 0; i < wordLists.length; i++) {
    for (const w of wordLists[i]) {
      out.push({ ...w, charStart: w.charStart + shift, charEnd: w.charEnd + shift });
    }
    shift += chars(texts[i]).length;
  }
  return out;
}

/**
 * The seam positions of a merge, as manual cut points on the merged text, so a
 * later split can cut exactly where the sentences were joined even when there
 * are no word timings to offer that position.
 *
 * `ranges[i]` supplies the seam's timestamp where known; a sentence with no
 * range contributes a seam with `offsetMs: null`, which is still a usable cut
 * position for text and explicitly not a claim about audio.
 * @returns {ManualPoint[]}
 */
export function mergeSeams(texts, ranges = []) {
  const seams = [];
  let shift = 0;
  for (let i = 0; i < texts.length - 1; i++) {
    shift += chars(texts[i]).length;
    const next = ranges[i + 1];
    seams.push({ charIndex: shift, offsetMs: next && Number.isFinite(next.offsetMs) ? next.offsetMs : null });
  }
  return seams;
}
