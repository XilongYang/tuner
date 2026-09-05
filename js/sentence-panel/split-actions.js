// Split/Merge/Import controller: the ONLY file in the sentence-panel domain
// that imports `store` or talks to the network (Azure transcription). Every
// action here follows the same shape -- mutate `sentences` via state.js's
// setSentences(), then call split-render.js's render() to repaint, then
// persist (store.createSession() for a fresh session, persistSession() for
// an edit to the current one). Pure geometry/slicing math lives in
// split-geometry.js; pure DOM painting lives in split-render.js -- neither
// of those two ever needs to import this one.

import { segment } from '../segment.js';
import { detectLang } from '../lang.js';
import { Recorder, encodeWav, decodeWavPcm16 } from '../recorder.js';
import * as store from '../store/index.js';
import { hashBlob } from '../store/hashing.js';
import { loadCredentials } from '../config.js';
import { transcribe } from '../stt.js';
import {
  els,
  sentences,
  setSentences,
  setCurrentSessionId,
  currentSplitMode,
  setCurrentSplitMode,
  globalHideText,
  sentenceToRecord,
  persistSession,
  sourceAudioBlob,
  setSourceAudio,
} from '../state.js';
import { refreshHistoryTreeIfOpen } from '../history-panel/index.js';
import { scheduleAutoSync } from '../sync/index.js';
import {
  decodeSourceAudio,
  sliceReferenceClip,
  resegmentByPunctuation,
  localeToLang,
} from './audio-decode.js';
import {
  sliceExactSplit,
  partitionWords,
  partitionManualPoints,
  isSessionLocked,
} from './split-geometry.js';
import { render, getSelectedIndices, resetSelection } from './split-render.js';

// Tracks an in-progress per-word "Retest" recording (opened from a word's score
// popover). Ephemeral only -- never touches `sentence.assessment` or persistSession() --
// so switching words, closing the popover, or a fresh Split can safely cancel it.
let activeWordRetest = null;
export function setActiveWordRetest(v) {
  activeWordRetest = v;
}
export function stopActiveWordRetest() {
  if (activeWordRetest) {
    activeWordRetest.stop();
    activeWordRetest = null;
  }
}

function setStatus(text, kind) {
  if (!els.audioImportStatus) return;
  els.audioImportStatus.hidden = !text;
  els.audioImportStatus.textContent = text || '';
  if (kind) els.audioImportStatus.dataset.kind = kind;
  else delete els.audioImportStatus.dataset.kind;
}

/**
 * Record a `'sentence'`-kind tombstone (store/tombstones.js) for each
 * sentence id a Merge/Split is about to replace, so cloud sync knows this id
 * is gone on purpose rather than "some other device just hasn't synced it
 * yet" -- without this, syncing soon after a Merge/Split (before every
 * device has seen it) can resurrect the very sentence(s) just replaced,
 * duplicating that audio range alongside the new result (see
 * mergeSentences()'s doc comment in sync/merge.js). Best-effort and
 * non-blocking to the caller's own local save: a failure here just means
 * this one Merge/Split doesn't get sync protection, not that the
 * Merge/Split itself failed.
 */
async function tombstoneReplacedSentences(ids) {
  if (!ids.length || !store.isSupported()) return;
  try {
    await Promise.all(ids.map((id) => store.recordTombstone('sentence', id)));
  } catch (err) {
    console.warn('Failed to tombstone replaced sentence(s) (sync may resurrect them):', err);
  }
}

/**
 * Build the merged sentence's reference audio. Two paths:
 *
 * Preferred: every selected sentence is an audio-imported slice with a known
 * [sourceOffsetMs, sourceDurationMs] into the CURRENT session's pristine
 * sourceAudioBlob (state.js) -- re-slice ONE fresh clip straight from that
 * untouched original file, spanning the merged sentences' full time range,
 * rather than concatenating already-resampled/normalized derivative clips.
 * This is what keeps repeated Merge/Split lossless: every operation traces
 * back to the original source, never to a previous operation's output, so
 * error never compounds no matter how many times a sentence gets divided and
 * recombined. The merged sentence keeps its own [sourceOffsetMs,
 * sourceDurationMs] (the union of the inputs') so it stays just as
 * losslessly splittable/mergeable afterward.
 *
 * Fallback: no source file available (a session saved before this existed,
 * or a sentence missing its timestamp for some other reason) -- decode and
 * concatenate each sentence's own already-cut WAV clip instead. Still
 * correct, just carries forward whatever resampling/normalization error
 * those clips already had, and the result has no source timestamps of its
 * own (so a *further* split/merge on it falls back the same way).
 *
 * Either way, returns null on any mismatch/failure rather than throwing,
 * since losing the reference is an acceptable fallback but a broken Merge
 * button is not.
 */
async function spliceReferenceAudio(mergedSentences) {
  if (sourceAudioBlob && mergedSentences.every((s) => (
    s.referenceSource === 'import' && s.sourceOffsetMs != null && s.sourceDurationMs != null
  ))) {
    try {
      const offsetMs = Math.min(...mergedSentences.map((s) => s.sourceOffsetMs));
      const endMs = Math.max(...mergedSentences.map((s) => s.sourceOffsetMs + s.sourceDurationMs));
      const decoded = await decodeSourceAudio(sourceAudioBlob);
      const blob = sliceReferenceClip(decoded, offsetMs, endMs - offsetMs);
      return { blob, sourceOffsetMs: offsetMs, sourceDurationMs: endMs - offsetMs };
    } catch (err) {
      console.warn('Failed to re-slice merged reference audio from the source file, falling back to concatenation:', err);
      // fall through to the concatenation fallback below
    }
  }

  if (!mergedSentences.every((s) => s.referenceSource === 'import' && s.referenceBlob)) return null;
  try {
    const decoded = await Promise.all(mergedSentences.map(async (s) => {
      const buf = await s.referenceBlob.arrayBuffer();
      return decodeWavPcm16(buf);
    }));
    const sampleRate = decoded[0].sampleRate;
    if (!decoded.every((d) => d.sampleRate === sampleRate)) return null;

    let total = 0;
    for (const d of decoded) total += d.samples.length;
    const combined = new Float32Array(total);
    let offset = 0;
    for (const d of decoded) {
      combined.set(d.samples, offset);
      offset += d.samples.length;
    }
    return { blob: new Blob([encodeWav(combined, sampleRate)], { type: 'audio/wav' }), sourceOffsetMs: null, sourceDurationMs: null };
  } catch (err) {
    console.warn('Failed to splice reference audio for the merged sentence, discarding it instead:', err);
    return null;
  }
}

/**
 * Concatenate the selected (always-contiguous) sentences into one. The
 * merged text no longer corresponds to any single original sentence, so its
 * recording/score are always discarded -- the user re-records/re-scores the
 * merged sentence like any freshly split one. Its reference audio is kept
 * (spliced together, see spliceReferenceAudio() above) when every selected
 * sentence came from an audio import; otherwise it's discarded too, same as
 * the recording.
 */
export async function mergeSelectedSentences() {
  const selIdx = getSelectedIndices();
  if (selIdx.length < 2) return;
  stopActiveWordRetest();

  const merged = selIdx.map((i) => sentences[i]);
  const texts = merged.map((s) => s.text);
  const joinedText = texts.join('');

  // Re-base each merged sentence's own words/manualPoints onto the joined
  // text's character positions (a running offset of each prior sentence's
  // own text length -- no separator is inserted between them, so a split
  // pointer's charIndex here lines up exactly with a character boundary in
  // joinedText), and record the seam between two consecutive merged
  // sentences as a manual pointer -- so if this merged
  // sentence gets split apart again later, that exact point (which may have
  // required an earlier Merge to discover in the first place) is immediately
  // available to click again rather than having to be rediscovered. Skipped
  // when the right sentence
  // already starts on one of its own word pointers there, which would just
  // draw two triangles on top of each other for the same spot.
  const combinedWords = [];
  const combinedManual = [];
  let charOffset = 0;
  merged.forEach((s, i) => {
    // Only an 'import' sentence's words/manualPoints share one coherent
    // absolute timeline (sourceOffsetMs) with the rest of this merge -- see
    // spliceReferenceAudio() above, which only re-slices/concatenates real
    // audio under that same condition. A 'tts' sentence's words[] (see
    // tts-player.js's ensureTtsWords()) are real too, but timestamped
    // against that ONE sentence's own separately-synthesized clip starting
    // at 0 -- concatenating those ms values as if on one shared timeline
    // would be nonsense, and spliceReferenceAudio() already declines to
    // preserve/splice that audio for a merge at all. Carrying its words
    // forward anyway would draw "exact Azure word boundary" triangles with
    // no real audio (or the wrong audio) behind them, which is worse than
    // just falling back to getSplitPointers()'s textSplitPoints() synthetic
    // ones like any other merge without exact data.
    if (s.referenceSource === 'import') {
      for (const w of s.words || []) {
        combinedWords.push({ ...w, charStart: w.charStart + charOffset, charEnd: w.charEnd + charOffset });
      }
      for (const p of s.manualPoints || []) {
        combinedManual.push({ ...p, charIndex: p.charIndex + charOffset });
      }
      if (i > 0 && s.sourceOffsetMs != null) {
        const seamAlreadyAWord = (s.words || []).some((w) => w.charStart === 0 && w.offsetMilliseconds === s.sourceOffsetMs);
        if (!seamAlreadyAWord) {
          combinedManual.push({ offsetMilliseconds: s.sourceOffsetMs, charIndex: charOffset });
        }
      }
    }
    charOffset += texts[i].length;
  });

  if (els.mergeBtn) els.mergeBtn.disabled = true;
  let splicedRef;
  try {
    splicedRef = await spliceReferenceAudio(merged);
  } finally {
    if (els.mergeBtn) els.mergeBtn.disabled = false;
  }

  for (const s of merged) {
    s.recorder.dispose(); // also revokes recordingUrl, if any
    if (s.referenceUrl) URL.revokeObjectURL(s.referenceUrl);
  }

  const newSentence = {
    id: crypto.randomUUID(),
    text: joinedText,
    lang: detectLang(joinedText),
    hidden: merged[0].hidden,
    recorder: new Recorder(),
    recordingUrl: null,
    recordingBlob: null,
    recordingHash: null,
    assessment: null,
    referenceBlob: splicedRef ? splicedRef.blob : null,
    referenceUrl: splicedRef ? URL.createObjectURL(splicedRef.blob) : null,
    referenceHash: null,
    referenceSource: splicedRef ? 'import' : null,
    sourceOffsetMs: splicedRef ? splicedRef.sourceOffsetMs : null,
    sourceDurationMs: splicedRef ? splicedRef.sourceDurationMs : null,
    words: combinedWords.length ? combinedWords : null,
    manualPoints: combinedManual.length ? combinedManual : null,
  };

  const next = sentences.slice();
  next.splice(selIdx[0], selIdx.length, newSentence);
  setSentences(next);
  resetSelection();

  render();
  await tombstoneReplacedSentences(merged.map((s) => s.id));
  persistSession();
}

// ---- Sentence list ----

export async function handleSplit() {
  if (isSessionLocked()) {
    // Either an audio-imported session, or a plain text session that's
    // already been split once: the practice text box is locked/hidden
    // (split-render.js's applyAudioSessionLock()), so there's no text here
    // to (re-)split -- the button becomes "New Session" instead (see the
    // same function), clearing the screen so a fresh session can be
    // started.
    startNewSession();
    return;
  }

  const parts = segment(els.input.value);
  stopActiveWordRetest();
  // Release resources from the previous recordings
  for (const s of sentences) s.recorder.dispose();

  setCurrentSplitMode('auto');
  setSentences(parts.map((text) => ({
    id: crypto.randomUUID(),
    text,
    lang: detectLang(text),
    hidden: globalHideText, // defaults to the global switch
    recorder: new Recorder(),
    recordingUrl: null,
    recordingBlob: null,
    recordingHash: null,
    assessment: null,
    referenceBlob: null,
    referenceUrl: null,
    referenceHash: null,
    referenceSource: null,
  })));

  // A plain text Split has no source audio -- clear any left over from a
  // previous audio-imported session (see state.js's sourceAudioBlob).
  setSourceAudio(null, null);

  render();

  // Each Split starts a new saved session (local only, via IndexedDB).
  setCurrentSessionId(null);
  if (sentences.length && store.isSupported()) {
    try {
      setCurrentSessionId(await store.createSession({
        inputText: els.input.value,
        splitMode: 'auto',
        sentences: sentences.map(sentenceToRecord),
        sourceAudioBlob: null,
        sourceAudioHash: null,
      }));
      refreshHistoryTreeIfOpen();
      scheduleAutoSync();
    } catch (err) {
      console.warn('Failed to save session locally:', err);
    }
  }
}

/**
 * The Split button's action for an audio-imported session (see
 * split-render.js's applyAudioSessionLock(): it's relabeled "New Session"
 * there). With the practice text box locked read-only, Split's usual job --
 * turn edited text into a new sentence list -- has nothing to do; this
 * instead clears the screen back to a blank auto-mode slate, since without
 * it there'd be no way left to start a plain text session again once an
 * audio session is open. Doesn't touch IndexedDB: no session exists until
 * the next real Split, exactly like on first load.
 *
 * Also reused (via sentence-panel/index.js) to clear the workspace back to
 * this same blank slate when the session currently on screen gets deleted
 * from the History sidebar -- see confirmDeleteSession() in
 * history-panel/actions.js.
 */
export function startNewSession() {
  stopActiveWordRetest();
  for (const s of sentences) s.recorder.dispose();
  setSentences([]);
  els.input.value = '';
  setCurrentSessionId(null);
  setCurrentSplitMode('auto');
  setSourceAudio(null, null);
  if (els.audioImportStatus) els.audioImportStatus.hidden = true;
  render();
}

// ---- Click-to-split ----
// Every splittable position already carries its own clickable triangle
// (split-render.js's buildTextEl()); the row's body click handler (row.js)
// just delegates to whichever `.split-pointer` triangle was clicked and
// calls splitAtPointer() below directly -- there's no separate
// click-anywhere marker/hint step.

/** Build the two new sentences a split produces and swap them into
 *  `sentences` in place of the original -- shared by every split path below
 *  (exact-pointer, manual-fine-tune, text-only). `refs` is the
 *  {left,right:{blob,sourceOffsetMs,sourceDurationMs}} pair from
 *  sliceExactSplit() (split-geometry.js), or null to leave both halves
 *  without reference audio. Recording/score never carry over, same as
 *  Merge -- there's no way to know which portion of a user recording
 *  corresponds to either half. Calls render() (not pure), which is why this
 *  lives here rather than in split-geometry.js alongside the rest of the
 *  slicing/partitioning math. */
function commitTwoParts(sentence, pos, leftText, rightText, refs, wordsParts, manualParts) {
  sentence.recorder.dispose(); // also revokes recordingUrl, if any
  if (sentence.referenceUrl) URL.revokeObjectURL(sentence.referenceUrl);

  const makePart = (text, ref, words, manualPoints) => ({
    id: crypto.randomUUID(),
    text,
    lang: detectLang(text),
    hidden: sentence.hidden,
    recorder: new Recorder(),
    recordingUrl: null,
    recordingBlob: null,
    recordingHash: null,
    assessment: null,
    referenceBlob: ref ? ref.blob : null,
    referenceUrl: ref ? URL.createObjectURL(ref.blob) : null,
    referenceHash: null,
    referenceSource: ref ? 'import' : null,
    sourceOffsetMs: ref ? ref.sourceOffsetMs : null,
    sourceDurationMs: ref ? ref.sourceDurationMs : null,
    words: words && words.length ? words : null,
    manualPoints: manualPoints && manualPoints.length ? manualPoints : null,
  });

  const next = sentences.slice();
  next.splice(pos, 1,
    makePart(leftText, refs && refs.left, wordsParts && wordsParts.left, manualParts && manualParts.left),
    makePart(rightText, refs && refs.right, wordsParts && wordsParts.right, manualParts && manualParts.right));
  setSentences(next);
  render();
}

/**
 * Split a sentence exactly at a known pointer (a triangle click in row.js,
 * or the row's Split button when the pending marker happens to sit exactly
 * on one) -- no preview step, because a pointer IS a real Azure word
 * boundary, a previously-confirmed manual point, or (split-geometry.js's
 * getSplitPointers()/textSplitPoints() fallback) a plain character/word
 * boundary with no audio behind it at all, never a guess. Re-slices both
 * halves straight from the pristine source at that exact ms when there's
 * real reference audio to slice (sentence.referenceSource === 'import'); a
 * sentence with none -- every plain text Split, plus any import Azure
 * returned no per-word data for -- just splits the text, the same single
 * code path either way.
 */
export async function splitAtPointer(sentence, charIndex, ms) {
  const pos = sentences.findIndex((s) => s.id === sentence.id);
  if (pos === -1) return;
  const chars = Array.from(sentence.text);
  // Raw slice, no trim() on either side: the split point itself carries
  // whatever whitespace sits right at that character boundary (for a real
  // word pointer, that's the space between this word and the previous one)
  // as part of the LEFT half rather than discarding it -- so an English
  // "Alpha beta" split at "beta"'s own charStart produces "Alpha " (with its
  // trailing space) + "beta", not "Alpha" + "beta". That matters because
  // mergeSelectedSentences() joins sentence texts back together with NO
  // separator of its own (see its doc comment above) -- if a space vanished
  // here, splitting and then re-merging would lose it for good, one Split
  // away from every previously-merged sentence.
  const leftText = chars.slice(0, charIndex).join('');
  const rightText = chars.slice(charIndex).join('');
  if (!leftText.trim() || !rightText.trim()) return;

  stopActiveWordRetest();

  let refs = null;
  if (sourceAudioBlob && sentence.referenceSource === 'import'
      && sentence.sourceOffsetMs != null && sentence.sourceDurationMs != null) {
    try {
      const decoded = await decodeSourceAudio(sourceAudioBlob);
      refs = sliceExactSplit(decoded, sentence.sourceOffsetMs, sentence.sourceOffsetMs + sentence.sourceDurationMs, ms);
    } catch (err) {
      console.warn('Failed to slice exact word-boundary split audio, discarding reference audio instead:', err);
    }
  }

  commitTwoParts(sentence, pos, leftText, rightText, refs,
    partitionWords(sentence.words, charIndex), partitionManualPoints(sentence.manualPoints, charIndex));
  await tombstoneReplacedSentences([sentence.id]);
  persistSession();
}

// ---- Audio import ----
// Audio import: upload an audio file with no reference text, transcribe it via
// Azure's Fast Transcription API (stt.js), re-segment the transcript by
// punctuation (the same rule text Split uses) rather than Azure's own
// pause-based phrase boundaries, slice the original audio to match using
// word-level timestamps, and start a new session from the clips.
//
// Minimal implementation: sentences go straight from the response into a
// saved session -- there is intentionally no review/merge/adjust step here yet.

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
    const parts = segments.map((seg) => ({
      text: seg.text,
      lang: seg.lang,
      offsetMilliseconds: seg.offsetMilliseconds,
      durationMilliseconds: seg.durationMilliseconds,
      blob: sliceReferenceClip(decodedSource, seg.offsetMilliseconds, seg.durationMilliseconds),
      // Only the punctuation-resegmented path (resegmentByPunctuation above)
      // carries real per-word timestamps; the raw-phrase fallback has none,
      // which just means this sentence gets no split-point triangles later
      // (split-geometry.js's getSplitPointers() falls back to a plain
      // text-only split for it) -- see the "no Azure data" case in that
      // module's doc comments.
      words: seg.words || [],
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
    // and hide Clear for an audio-imported session (see split-geometry.js's
    // isSessionLocked() / split-render.js's applyAudioSessionLock()).
    setCurrentSplitMode('audio');
    // The original file itself, kept around (state.js's sourceAudioBlob) so
    // Split/Merge can always re-slice a fresh, lossless clip straight from
    // it -- see decodeSourceAudio()/sliceReferenceClip() in audio-decode.js.
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
      // text), if any -- see resegmentByPunctuation() in audio-decode.js and
      // split-geometry.js's getSplitPointers(). No user-confirmed manual
      // split points exist yet on a freshly imported sentence.
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
