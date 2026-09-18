// Standalone audio for one vocab occurrence (a contiguous run of a sentence's
// sentence.words[] entries the user picked in the "记录生词" popover -- see
// vocab-picker.js). Two sourcing paths, matching the sentence's own
// referenceSource exactly the way Speak/Export already branch on it:
//
// - referenceSource === 'import': the sentence's reference clip is a real
//   slice of the session's original recording, so the word span's own real
//   timestamps (offsetMilliseconds/durationMilliseconds, already in the
//   ORIGINAL source's absolute timeline -- see split-geometry.js's
//   getSplitPointers() doc comment) let this re-slice a fresh, lossless clip
//   straight from state.js's sourceAudioBlob, the exact same source
//   split-actions.js's spliceReferenceAudio()/handleAudioResplit() already
//   re-slice from for Split/Merge, rather than the sentence's own
//   already-cut referenceBlob (which would need re-decoding just to re-slice
//   a sub-range, for no benefit).
// - anything else (referenceSource === 'tts', or no reference yet): there's
//   no real recording to slice, so this synthesizes a fresh, standalone clip
//   for just the picked text via the same getTtsEntry() playWord() in
//   assessment.js already uses for single-word playback -- the difference is
//   this keeps the resulting Blob (to persist into the vocab entry) instead
//   of just playing it once and discarding it.
//
// Returns null (never throws) when there's nothing usable to produce --
// missing source audio, no credentials for synthesis, or a zero-length
// range -- so the caller can still create a text-only vocab entry rather
// than failing the whole "add to vocab" action over one occurrence's audio.

import { sourceAudioBlob } from '../state.js';
import { decodeSourceAudio, sliceReferenceClip } from './audio-decode.js';
import { getTtsEntry } from '../tts-player.js';
import { hasCredentials } from '../config.js';
import { LOCALES } from '../lang.js';

/**
 * `wordGroup` is a non-empty, contiguous run of `sentence.words[]` entries
 * (already sorted by charStart -- see vocab-picker.js's grouping). Returns
 * `{ blob, text }` or null.
 */
export async function resolveVocabAudio(sentence, wordGroup) {
  if (!wordGroup || !wordGroup.length) return null;
  const first = wordGroup[0];
  const last = wordGroup[wordGroup.length - 1];
  const chars = Array.from(sentence.text);
  const text = chars.slice(first.charStart, last.charEnd).join('');
  if (!text) return null;

  if (sentence.referenceSource === 'import') {
    if (!sourceAudioBlob) return null;
    const startMs = first.offsetMilliseconds;
    const durationMs = (last.offsetMilliseconds + last.durationMilliseconds) - startMs;
    if (!(durationMs > 0)) return null;
    try {
      const decoded = await decodeSourceAudio(sourceAudioBlob);
      const blob = sliceReferenceClip(decoded, startMs, durationMs);
      return { blob, text };
    } catch (err) {
      console.warn('Vocab audio slice failed:', err);
      return null;
    }
  }

  // Synthesized (or no reference audio yet -- shouldn't normally reach here
  // given the "记录生词" button is only enabled once sentence.words exists,
  // but a sentence can have real word timing from a TTS alignment without
  // ever having been an 'import' source, so this branch is the correct
  // fallback either way, not just a defensive one).
  if (!hasCredentials()) return null;
  try {
    const entry = await getTtsEntry(text, LOCALES[sentence.lang]);
    return { blob: entry.blob, text };
  } catch (err) {
    console.warn('Vocab audio synthesis failed:', err);
    return null;
  }
}
