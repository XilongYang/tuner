// Audio decoding/slicing + Fast-Transcription-result re-segmentation.
// Pure data/logic only -- no DOM, no store, no network of its own (transcribe()
// itself now lives in ../stt.js). The actual "Import audio" action (upload ->
// transcribe -> slice -> new session) is split-actions.js's handleAudioImport(),
// which calls into this file the same way it calls into split-geometry.js.

import { encodeWav } from '../recorder.js';
import { TERMINATORS } from '../segment.js';

// Padding added to each side of a punctuation-resegmented sentence's word-derived
// time range. Azure's own phrase boundaries (the pause-based segmentation this
// re-splits) already carry natural lead-in/lead-out silence; a bare word's own
// offset/duration is tighter than that and can clip the very start/end of speech,
// so this restores a small margin. Clamped to the file's bounds AND to at most
// half the gap to the neighboring word on that side (see resegmentByPunctuation()
// below) -- a full, un-clamped 120ms on both sides of two closely-spoken
// sentences can overlap and pull a bit of the neighbor's speech into this
// clip, audible as a "tail" (尾巴) at the sentence's start/end.
const SLICE_PAD_MS = 120;

/**
 * Slice one channel's Float32 samples to a phrase's [offset, offset+duration)
 * range (both in ms), at `sampleRate`. Always copies (never a view) -- encodeWav's
 * normalize() mutates its input in place, and other phrases still need to read
 * the original decoded buffer untouched.
 */
function sliceSamples(channelData, sampleRate, offsetMs, durationMs) {
  const start = Math.max(0, Math.round((offsetMs / 1000) * sampleRate));
  const end = Math.min(channelData.length, Math.round(((offsetMs + durationMs) / 1000) * sampleRate));
  return channelData.slice(start, Math.max(start, end));
}

/**
 * Decode a source audio Blob (the original file a session was imported from,
 * kept around as session.sourceAudioBlob -- see its doc comment in
 * state.js) into raw Float32 samples + sample rate. Exported so split-actions.js
 * (Split/Merge/Import) can re-slice a fresh clip straight from this pristine
 * source every time, rather than resampling/renormalizing an already-derived
 * per-sentence clip over and over and compounding that error -- the whole
 * point of keeping this original file around at all.
 */
export async function decodeSourceAudio(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtx();
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    return { channelData: audioBuffer.getChannelData(0), sampleRate: audioBuffer.sampleRate };
  } finally {
    audioCtx.close().catch(() => {});
  }
}

/**
 * Cut one [offsetMs, offsetMs + durationMs) reference clip out of a decoded
 * source (decodeSourceAudio() above) and encode it the same way the initial
 * import does -- a mono/16-bit/16kHz WAV Blob (encodeWav() in recorder.js).
 */
export function sliceReferenceClip({ channelData, sampleRate }, offsetMs, durationMs) {
  const samples = sliceSamples(channelData, sampleRate, offsetMs, durationMs);
  return new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' });
}

/** Exported alongside resegmentByPunctuation()'s fallback path in
 *  split-actions.js's handleAudioImport(), which needs the same locale ->
 *  'ja'/'en' mapping when Azure returns no usable word-level timing to
 *  re-segment against. */
export function localeToLang(locale) {
  return locale && locale.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

/**
 * Flatten every phrase's word-level timestamps into one chronological list,
 * and rebuild the full transcript alongside it, recording exactly which
 * character range of that transcript each word occupies. That per-word
 * [start, end) range is what lets a punctuation re-split of the rebuilt
 * transcript (below) be mapped back onto exact audio timestamps -- it means
 * this never has to fuzzy-match sentence text against the words again.
 */
function buildWordTimeline(phrases) {
  const words = [];
  let text = '';
  for (const phrase of phrases) {
    const lang = localeToLang(phrase.locale);
    // Represent the natural pause between phrases (Azure's own pause-based
    // segmentation) as a real space, regardless of language -- this matters
    // even between two Japanese phrases, and is essential when a phrase ends
    // in an ASCII '.': TERMINATORS only treats '.' as terminal when followed
    // by whitespace/end (segment.js), so without this, a phrase break right
    // after "...weeks." glued straight onto the next phrase's first
    // character would hide that sentence boundary entirely.
    if (text.length > 0 && !/\s$/.test(text)) text += ' ';
    for (const w of phrase.words || []) {
      if (!w.text) continue;
      // Within a phrase: Japanese/Chinese-style text has no spaces between
      // words; anything else (English etc.) does.
      if (lang !== 'ja' && text.length > 0 && !/\s$/.test(text)) text += ' ';
      const start = text.length;
      text += w.text;
      words.push({ offsetMilliseconds: w.offsetMilliseconds, durationMilliseconds: w.durationMilliseconds, lang, start, end: text.length });
    }
  }
  return { text, words };
}

/**
 * Re-segment a Fast Transcription result by punctuation -- the exact same
 * TERMINATORS rule text Split uses (segment.js) -- instead of trusting
 * Azure's own pause-based phrase boundaries, which often land mid-sentence.
 * Each resulting sentence's audio range comes from the first/last word (by
 * character overlap) that fell inside it, per buildWordTimeline() above.
 * Returns [] if there's no usable word-level data to align against (the
 * caller falls back to the raw phrases in that case).
 */
export function resegmentByPunctuation(phrases, totalDurationMs) {
  const { text, words } = buildWordTimeline(phrases);
  if (!text.trim() || !words.length) return [];

  const spans = [];
  let lastIndex = 0;
  let match;
  TERMINATORS.lastIndex = 0;
  while ((match = TERMINATORS.exec(text)) !== null) {
    spans.push([lastIndex, match.index + match[0].length]);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) spans.push([lastIndex, text.length]);

  const parts = [];
  for (const [rawStart, rawEnd] of spans) {
    const raw = text.slice(rawStart, rawEnd);
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Narrow the span to exclude the whitespace trim() just dropped, so it
    // doesn't pull in a neighboring word that contributed none of this text.
    const start = rawStart + (raw.length - raw.trimStart().length);
    const end = rawEnd - (raw.length - raw.trimEnd().length);
    const spanWords = words.filter((w) => w.start < end && w.end > start);
    if (!spanWords.length) continue;

    const first = spanWords[0];
    const last = spanWords[spanWords.length - 1];
    const rawOffset = first.offsetMilliseconds;
    const rawEndMs = last.offsetMilliseconds + last.durationMilliseconds;

    // How much of the SLICE_PAD_MS margin each edge can actually use without
    // reaching into the neighboring word (which, at a sentence boundary, is
    // the neighboring sentence's own speech): at most half of the real gap
    // to that word, so two sentences padding toward each other from opposite
    // sides can meet at the gap's midpoint but never overlap. `words` is the
    // full chronological timeline (buildWordTimeline() above), so the word
    // immediately before/after this span's own words -- found by reference,
    // not by span/character position -- is the true neighbor regardless of
    // which sentence it ends up in.
    const firstIdx = words.indexOf(first);
    const lastIdx = words.indexOf(last);
    const prevWord = firstIdx > 0 ? words[firstIdx - 1] : null;
    const nextWord = lastIdx < words.length - 1 ? words[lastIdx + 1] : null;
    const leftGapMs = prevWord
      ? Math.max(0, rawOffset - (prevWord.offsetMilliseconds + prevWord.durationMilliseconds))
      : Infinity;
    const rightGapMs = nextWord ? Math.max(0, nextWord.offsetMilliseconds - rawEndMs) : Infinity;
    const leftPadMs = Math.min(SLICE_PAD_MS, leftGapMs / 2);
    const rightPadMs = Math.min(SLICE_PAD_MS, rightGapMs / 2);

    const offsetMilliseconds = Math.max(0, rawOffset - leftPadMs);
    const endMs = totalDurationMs != null ? Math.min(totalDurationMs, rawEndMs + rightPadMs) : rawEndMs + rightPadMs;
    const jaWordCount = spanWords.filter((w) => w.lang === 'ja').length;

    // Keep each word's own timestamp + its position within THIS sentence's
    // own (trimmed) text, re-based from the full-transcript character index
    // (w.start/w.end) to a 0-based offset into `trimmed` -- this is what
    // later lets the Split UI (sentence-panel/split-render.js) draw a clickable
    // triangle at every real Azure word boundary instead of only ever
    // guessing a cut point from the character ratio of the whole sentence.
    // Clamped defensively in case a word straddles the punctuation-trim
    // boundary by a character or two.
    const spanWordPointers = spanWords.map((w) => ({
      offsetMilliseconds: w.offsetMilliseconds,
      durationMilliseconds: w.durationMilliseconds,
      charStart: Math.max(0, Math.min(trimmed.length, w.start - start)),
      charEnd: Math.max(0, Math.min(trimmed.length, w.end - start)),
    }));

    parts.push({
      text: trimmed,
      lang: jaWordCount * 2 >= spanWords.length ? 'ja' : 'en',
      offsetMilliseconds,
      durationMilliseconds: Math.max(0, endMs - offsetMilliseconds),
      words: spanWordPointers,
    });
  }
  return parts;
}
