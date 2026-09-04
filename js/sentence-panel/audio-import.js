// Audio import: upload an audio file with no reference text, transcribe it via
// Azure's Fast Transcription API, re-segment the transcript by punctuation
// (the same rule text Split uses) rather than Azure's own pause-based phrase
// boundaries, slice the original audio to match using word-level timestamps,
// and start a new session from the clips.
//
// Minimal implementation: sentences go straight from the response into a
// saved session -- there is intentionally no review/merge/adjust step here yet.

import { Recorder, encodeWav } from '../recorder.js';
import { TERMINATORS } from '../segment.js';
import * as store from '../store/index.js';
import { hashBlob } from '../store/hashing.js';
import { loadCredentials } from '../config.js';
import {
  els,
  sentences,
  setSentences,
  setCurrentSessionId,
  setCurrentSplitMode,
  globalHideText,
  sentenceToRecord,
  setSourceAudio,
} from '../state.js';
import { refreshHistoryTreeIfOpen } from '../history-panel/index.js';
import { scheduleAutoSync } from '../sync/index.js';
import { stopActiveWordRetest, render } from './split.js';

const API_VERSION = '2025-10-15';

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

function setStatus(text, kind) {
  if (!els.audioImportStatus) return;
  els.audioImportStatus.hidden = !text;
  els.audioImportStatus.textContent = text || '';
  if (kind) els.audioImportStatus.dataset.kind = kind;
  else delete els.audioImportStatus.dataset.kind;
}

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
 * state.js) into raw Float32 samples + sample rate. Exported so split.js can
 * re-slice a fresh clip straight from this pristine source on every
 * Split/Merge, rather than resampling/renormalizing an already-derived
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

function localeToLang(locale) {
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
    // later lets the Split UI (sentence-panel/split.js) draw a clickable
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

/**
 * Exported so tts-player.js's alignWordsForClip() can reuse the exact same
 * Fast Transcription call to re-transcribe a synthesized TTS clip and
 * recover real word-level timestamps for it -- see that module's doc
 * comment for why this is safe to do generically for any audio Blob.
 */
export async function transcribe(file, creds) {
  const endpoint = `https://${creds.resourceName}.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=${API_VERSION}`;
  const form = new FormData();
  form.append('audio', file);
  form.append('definition', JSON.stringify({ locales: ['ja-JP', 'en-US'] }));
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': creds.key },
    body: form,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Azure returned HTTP ${resp.status}${text ? `: ${text}` : ''}`);
  }
  return resp.json();
}

/** Import an audio file: transcribe -> slice -> encode -> new session. */
export async function handleAudioImport(file) {
  if (!file) return;
  const creds = loadCredentials();
  if (!creds || !creds.resourceName) {
    alert('Set your Azure Speech key, region, and resource name (custom subdomain) in '
      + 'Azure settings first -- Import audio needs the resource name specifically.');
    return;
  }

  setStatus('Uploading and transcribing…', 'info');
  try {
    const result = await transcribe(file, creds);
    const phrases = (result && result.phrases) || [];
    if (!phrases.length) {
      setStatus('Azure found no speech in this file.', 'error');
      return;
    }

    setStatus('Decoding audio…', 'info');
    const decodedSource = await decodeSourceAudio(file);

    setStatus('Re-segmenting by punctuation…', 'info');
    let segments = resegmentByPunctuation(phrases, result.durationMilliseconds);
    if (!segments.length) {
      // No usable word-level timestamps to align against -- fall back to
      // Azure's own pause-based phrase boundaries (the original behavior).
      segments = phrases.map((phrase) => ({
        text: phrase.text,
        lang: localeToLang(phrase.locale),
        offsetMilliseconds: phrase.offsetMilliseconds,
        durationMilliseconds: phrase.durationMilliseconds,
      }));
    }

    setStatus('Slicing and encoding clips…', 'info');
    const parts = segments.map((segment) => ({
      text: segment.text,
      lang: segment.lang,
      offsetMilliseconds: segment.offsetMilliseconds,
      durationMilliseconds: segment.durationMilliseconds,
      blob: sliceReferenceClip(decodedSource, segment.offsetMilliseconds, segment.durationMilliseconds),
      // Only the punctuation-resegmented path (resegmentByPunctuation above)
      // carries real per-word timestamps; the raw-phrase fallback has none,
      // which just means this sentence gets no split-point triangles later
      // (sentence-panel/split.js falls back to a plain text-only split for
      // it) -- see the "no Azure data" case in that module's doc comments.
      words: segment.words || [],
    }));

    setStatus('Fingerprinting source audio…', 'info');
    // Hashed once, here, and then just carried through on every later save
    // (state.js's sourceAudioHash/persistSession()) -- see the doc comment on
    // sourceAudioHash in store/sessions.js's updateSession() for why this
    // potentially-multi-MB file is never re-hashed on every subsequent save.
    const sourceAudioHash = await hashBlob(file);

    stopActiveWordRetest();
    // Release resources from the previous recordings, same as a text Split.
    for (const s of sentences) s.recorder.dispose();

    // Before render(): it reads this to lock the practice text box read-only
    // and hide Clear for an audio-imported session (see split.js).
    setCurrentSplitMode('audio');
    // The original file itself, kept around (state.js's sourceAudioBlob) so
    // Split/Merge can always re-slice a fresh, lossless clip straight from
    // it -- see decodeSourceAudio()/sliceReferenceClip() above.
    setSourceAudio(file, sourceAudioHash);
    setSentences(parts.map((part) => ({
      id: crypto.randomUUID(),
      text: part.text,
      lang: part.lang,
      hidden: globalHideText,
      recorder: new Recorder(),
      // The user's own take -- left empty just like a fresh text Split, so
      // Playback/Score/Export (gated on recordingUrl/recordingBlob/assessment
      // in row.js) stay hidden until the user actually records themselves.
      // The imported clip goes only into referenceBlob below, not here.
      recordingUrl: null,
      recordingBlob: null,
      recordingHash: null,
      assessment: null,
      // The permanent reference clip Speak plays (row.js) -- unlike
      // recordingBlob above, this is never overwritten by Record, since it's
      // the actual audio this sentence was transcribed from, not a synthesized
      // stand-in. referenceSource: 'import' tells row.js's language toggle not
      // to invalidate it the way a stale TTS reference would be.
      referenceUrl: URL.createObjectURL(part.blob),
      referenceBlob: part.blob,
      referenceHash: null,
      referenceSource: 'import',
      // Where this clip sits in sourceAudioBlob -- see its doc comment in
      // state.js.
      sourceOffsetMs: part.offsetMilliseconds,
      sourceDurationMs: part.durationMilliseconds,
      // This sentence's own Azure word timestamps (re-based to its own
      // text), if any -- see resegmentByPunctuation() above and
      // sentence-panel/split.js's getSplitPointers(). No user-confirmed
      // manual split points exist yet on a freshly imported sentence.
      words: part.words && part.words.length ? part.words : null,
      manualPoints: null,
    })));

    render();

    // Each import starts a new saved session (local only, via IndexedDB),
    // mirroring handleSplit()'s text-based flow.
    setCurrentSessionId(null);
    if (sentences.length && store.isSupported()) {
      try {
        setCurrentSessionId(await store.createSession({
          inputText: sentences.map((s) => s.text).join('\n'),
          splitMode: 'audio',
          sentences: sentences.map(sentenceToRecord),
          sourceAudioBlob: file,
          sourceAudioHash,
        }));
        refreshHistoryTreeIfOpen();
        scheduleAutoSync();
      } catch (err) {
        console.warn('Failed to save session locally:', err);
      }
    }

    setStatus(`Imported ${sentences.length} clip${sentences.length > 1 ? 's' : ''} from audio.`, 'info');
  } catch (err) {
    console.error('Audio import failed:', err);
    setStatus(`Audio import failed: ${err && err.message ? err.message : err}`, 'error');
  }
}
