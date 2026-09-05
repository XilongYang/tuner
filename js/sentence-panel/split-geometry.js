// Pure sentence/audio-geometry calculations for the sentence-panel domain: no
// DOM, no store, no network. Every function here is a straightforward
// transform of its inputs (or, for isSessionLocked(), of the live sentences/
// currentSplitMode state) into a result the UI layer (split-render.js) or the
// action layer (split-actions.js) then acts on. Safe to unit-test directly in
// Node -- none of this needs a browser.

import { sentences, currentSplitMode } from '../state.js';
import { sliceReferenceClip } from './audio-decode.js';

/** Whether the practice text box should be locked/hidden: true for any
 *  audio-imported session, and also for a plain text ('auto') session once
 *  it's actually been split -- sentences.length > 0 is what distinguishes
 *  "already split" from the blank slate 'auto' starts as before the first
 *  Split click (see currentSplitMode's doc comment in state.js). Read by
 *  split-render.js's applyAudioSessionLock() (to paint the lock) and
 *  split-actions.js's handleSplit() (to decide whether Split means "split"
 *  or "start a new session") -- kept here, rather than owned by either,
 *  since it's a pure predicate neither one should have to import from the
 *  other for. */
export function isSessionLocked() {
  return currentSplitMode === 'audio' || (currentSplitMode === 'auto' && sentences.length > 0);
}

/**
 * Every known exact split point for a sentence, sorted by character
 * position: one per Azure word boundary (sentence.words -- see
 * resegmentByPunctuation() in audio-decode.js) plus one per manually
 * confirmed point (sentence.manualPoints -- currently only ever populated by
 * mergeSelectedSentences()'s seam-preserving logic in split-actions.js, when
 * two previously-split sentences are merged back together). Both are real,
 * exact timestamps -- never a character-ratio guess -- which is what lets a
 * click directly on one (row.js) split immediately with no confirmation
 * step: there's nothing to verify by ear that isn't already known to be
 * correct. A sentence with neither (a plain text Split, or an import Azure
 * returned no per-word timing for) falls back to textSplitPoints() below
 * instead of offering nothing -- same triangle, same instant-split click,
 * just no timestamp behind it. Endpoints (charIndex 0 or the full text
 * length) are excluded -- splitting there would leave one side empty.
 */
export function getSplitPointers(sentence) {
  const len = Array.from(sentence.text).length;
  const pointers = [];
  for (const w of sentence.words || []) {
    if (w.charStart > 0 && w.charStart < len) {
      pointers.push({ charIndex: w.charStart, ms: w.offsetMilliseconds, kind: 'word' });
    }
  }
  for (const p of sentence.manualPoints || []) {
    if (p.charIndex > 0 && p.charIndex < len) {
      pointers.push({ charIndex: p.charIndex, ms: p.offsetMilliseconds, kind: 'manual' });
    }
  }
  if (!pointers.length) pointers.push(...textSplitPoints(sentence));
  pointers.sort((a, b) => a.charIndex - b.charIndex);
  return pointers;
}

/**
 * Synthesize split points straight from a sentence's own text, for the one
 * case getSplitPointers() above has no real data for: no Azure word
 * timestamps and no manual points either. Rather than leaving such a
 * sentence with no triangles at all (the split-point UI used to fall back to
 * a separate click-anywhere-then-Split-button flow just for this case --
 * see commitTextOnlySplit()'s previous doc comment, since removed along with
 * it), offer the same triangle at the same granularity a real Azure import
 * would have given this sentence: Japanese has no spaces to delimit words,
 * so every character boundary is offered; anything else (English and other
 * space-delimited scripts) offers only the boundary right after each run of
 * whitespace -- one triangle per word gap, sitting directly over the space,
 * matching exactly where a real word pointer's charStart would land. These
 * carry no timestamp (kind: 'text', ms: null) since there's no audio to
 * associate a time with -- splitAtPointer() (split-actions.js) only reads
 * `ms` when there's real reference audio to slice, which by construction a
 * sentence that reaches this function never has anything reliable to offer
 * anyway.
 */
function textSplitPoints(sentence) {
  const chars = Array.from(sentence.text);
  const points = [];
  if (sentence.lang === 'ja') {
    for (let i = 1; i < chars.length; i++) points.push({ charIndex: i, ms: null, kind: 'text' });
  } else {
    for (let i = 1; i < chars.length; i++) {
      if (/\s/.test(chars[i - 1]) && !/\s/.test(chars[i])) points.push({ charIndex: i, ms: null, kind: 'text' });
    }
  }
  return points;
}

/** Slice a decoded source at an EXACT ms split point -- no snapping/guessing,
 *  since every caller of this already knows the split point is either a real
 *  Azure word boundary or a user-confirmed manual point. Returns null if the
 *  split point would leave either side with zero duration. */
export function sliceExactSplit(decoded, rangeStartMs, rangeEndMs, splitMs) {
  const leftDurationMs = splitMs - rangeStartMs;
  const rightDurationMs = rangeEndMs - splitMs;
  if (!(leftDurationMs > 0) || !(rightDurationMs > 0)) return null;
  return {
    left: { blob: sliceReferenceClip(decoded, rangeStartMs, leftDurationMs), sourceOffsetMs: rangeStartMs, sourceDurationMs: leftDurationMs },
    right: { blob: sliceReferenceClip(decoded, splitMs, rightDurationMs), sourceOffsetMs: splitMs, sourceDurationMs: rightDurationMs },
  };
}

/** Partition a sentence's word pointers across a text split at `charIndex`,
 *  re-basing the right side's charStart/charEnd back to 0. */
export function partitionWords(words, charIndex) {
  const left = [];
  const right = [];
  for (const w of words || []) {
    if (w.charEnd <= charIndex) left.push(w);
    else if (w.charStart >= charIndex) right.push({ ...w, charStart: w.charStart - charIndex, charEnd: w.charEnd - charIndex });
    // A word straddling the split point itself can't happen for a pointer-
    // exact split (the split IS a word's own charStart); for a manual split
    // inside the gap between two pointers, no word occupies that gap by
    // definition -- so there's nothing to do for a straddling word here.
  }
  return { left, right };
}

/** Partition a sentence's manual pointers the same way. */
export function partitionManualPoints(manualPoints, charIndex) {
  const left = [];
  const right = [];
  for (const p of manualPoints || []) {
    if (p.charIndex < charIndex) left.push(p);
    else if (p.charIndex > charIndex) right.push({ ...p, charIndex: p.charIndex - charIndex });
  }
  return { left, right };
}
