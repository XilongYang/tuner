// Split action: turns the pasted input text into the sentence list and kicks
// off a new saved session. Also owns the hidden-text toggle helpers, since
// both Split (defaulting to the global switch) and the per-row hide button
// (in ./row.js) need to paint/apply the same hidden state.

import { segment } from '../segment.js';
import { detectLang } from '../lang.js';
import { Recorder, encodeWav, decodeWavPcm16 } from '../recorder.js';
import * as store from '../store/index.js';
import {
  els,
  sentences,
  setSentences,
  setCurrentSessionId,
  currentSplitMode,
  setCurrentSplitMode,
  globalHideText,
  sentenceToRecord,
  refreshInputMaskOverlay,
  persistSession,
  sourceAudioBlob,
  setSourceAudio,
} from '../state.js';
import { refreshHistoryTreeIfOpen } from '../history-panel/index.js';
import { scheduleAutoSync } from '../sync/index.js';
import { renderRow } from './row.js';
// Circular with audio-import.js (which imports render/stopActiveWordRetest
// from this module) -- safe, same as the rest of this codebase's
// history-panel/sentence-panel cycles: both sides only call into each other
// from inside functions, never at module-evaluation time.
import { decodeSourceAudio, sliceReferenceClip } from './audio-import.js';

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

// ---- Row selection + Merge ----
// Which sentence rows are checked for merging, kept as a Set of sentence ids
// rather than indices since the array can be rebuilt (render()) while a
// selection is live. The one invariant this whole block maintains is that
// the selected ids are always a CONTIGUOUS run of `sentences` -- "不允许跳选"
// (no skip-selecting) -- enforced by disabling every checkbox that isn't
// adjacent to the current run (see updateSelectionUI()), so toggleRowSelection()
// itself never has to reject a click.
let selectedIds = new Set();

function getSelectedIndices() {
  const idxs = [];
  sentences.forEach((s, i) => { if (selectedIds.has(s.id)) idxs.push(i); });
  return idxs;
}

/** Sync every row's checkbox (checked/disabled) and the Merge bar to `selectedIds`. */
function updateSelectionUI() {
  const selIdx = getSelectedIndices();
  const min = selIdx[0];
  const max = selIdx[selIdx.length - 1];

  sentences.forEach((sentence, idx) => {
    const cb = sentence._selectCheckbox;
    if (!cb) return;
    const selected = selectedIds.has(sentence.id);
    cb.checked = selected;
    if (sentence._row) sentence._row.classList.toggle('is-selected', selected);
    // Not selected: only enabled if picking it would extend the run by one
    // (or nothing is selected yet). Selected rows stay clickable so they can
    // always be removed.
    cb.disabled = !selected && selIdx.length > 0 && idx !== min - 1 && idx !== max + 1;
  });

  if (els.mergeBar) {
    const count = selectedIds.size;
    els.mergeBar.hidden = count < 1;
    if (els.mergeBarLabel) {
      els.mergeBarLabel.textContent = count === 1 ? '1 sentence selected' : `${count} sentences selected`;
    }
    if (els.mergeBtn) els.mergeBtn.hidden = count < 2;
  }
}

/** Toggle one row's checkbox. Only ever called for a checked/enabled checkbox,
 *  so the click is always either shrinking the current run from an end or
 *  extending it by one -- see updateSelectionUI()'s disabling logic above. */
export function toggleRowSelection(sentence) {
  const idx = sentences.findIndex((s) => s.id === sentence.id);
  if (idx === -1) return;
  const selIdx = getSelectedIndices();

  if (selectedIds.has(sentence.id)) {
    if (selIdx.length <= 1 || idx === selIdx[0] || idx === selIdx[selIdx.length - 1]) {
      selectedIds.delete(sentence.id);
    } else {
      // Unreachable via the UI (a middle row's checkbox is never disabled by
      // definition, so it's always removable without a gap), kept as a safe
      // fallback: drop the whole selection rather than leave one.
      selectedIds = new Set();
    }
  } else {
    selectedIds.add(sentence.id);
  }
  updateSelectionUI();
}

/** Clear the selection without merging (the Merge bar's Cancel button). */
export function clearRowSelection() {
  if (!selectedIds.size) return;
  selectedIds = new Set();
  updateSelectionUI();
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
  selectedIds = new Set();

  render();
  await tombstoneReplacedSentences(merged.map((s) => s.id));
  persistSession();
}

// ---- Sentence list ----

export async function handleSplit() {
  if (isSessionLocked()) {
    // Either an audio-imported session, or a plain text session that's
    // already been split once: the practice text box is locked/hidden
    // (applyAudioSessionLock() below), so there's no text here to (re-)split
    // -- the button becomes "New Session" instead (see the same function),
    // clearing the screen so a fresh session can be started.
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
 * applyAudioSessionLock(): it's relabeled "New Session" there). With the
 * practice text box locked read-only, Split's usual job -- turn edited text
 * into a new sentence list -- has nothing to do; this instead clears the
 * screen back to a blank auto-mode slate, since without it there'd be no way
 * left to start a plain text session again once an audio session is open.
 * Doesn't touch IndexedDB: no session exists until the next real Split,
 * exactly like on first load.
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

/** Whether the practice text box should be locked/hidden: true for any
 *  audio-imported session, and also for a plain text ('auto') session once
 *  it's actually been split -- sentences.length > 0 is what distinguishes
 *  "already split" from the blank slate 'auto' starts as before the first
 *  Split click (see currentSplitMode's doc comment in state.js). */
function isSessionLocked() {
  return currentSplitMode === 'audio' || (currentSplitMode === 'auto' && sentences.length > 0);
}

/** Lock the practice text box once a session has been split (audio-imported,
 *  or plain text after its first Split): there's no way yet to re-slice
 *  audio if the transcript is edited, and for a plain text session the box
 *  would just be a stale copy of what's already visible below -- editing
 *  (and Clear, which would blow the text away entirely) is disabled until
 *  that changes. Hidden outright rather than just read-only/greyed-out --
 *  the session's actual text lives on the sentence rows below (each with
 *  its own clickable split triangles now, see getSplitPointers()), so the
 *  box up top has nothing useful left to show; leaving it visible only
 *  invited trying to edit text that edits don't do anything to. Split
 *  becomes "New Session" (startNewSession() above) since it would otherwise
 *  have no text to act on. */
function applyAudioSessionLock() {
  const locked = isSessionLocked();
  els.input.readOnly = locked;
  els.input.classList.toggle('is-locked', locked);
  if (els.inputLabel) els.inputLabel.hidden = locked;
  if (els.inputMaskWrap) els.inputMaskWrap.hidden = locked;
  els.clearInputBtn.hidden = locked;
  els.clearInputBtn.disabled = locked;
  els.splitBtn.textContent = locked ? 'New Session' : 'Split';
}

export function render() {
  applyAudioSessionLock();
  refreshInputMaskOverlay();
  els.list.innerHTML = '';
  els.count.textContent = sentences.length
    ? `${sentences.length} ${sentences.length > 1 ? 'sentences' : 'sentence'}`
    : '';

  // A full re-render always rebuilds fresh sentence objects/ids (Split,
  // startNewSession, audio import, opening a saved session, ...), so any
  // previous row-selection state is stale -- drop it rather than let it
  // silently reference sentences that no longer exist.
  selectedIds = new Set();

  if (sentences.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-hint';
    empty.textContent = 'Paste text and click Split; sentences will appear here, one per line.';
    els.list.appendChild(empty);
    updateSelectionUI();
    return;
  }

  sentences.forEach((sentence, index) => {
    els.list.appendChild(renderRow(sentence, index));
  });
  updateSelectionUI();
}

/** Build the sentence text element; each non-whitespace character gets its own
 *  inline span so that when hidden (.sentence-row.is-hidden, see CSS) it renders
 *  as an individual black block per character rather than one continuous bar --
 *  whitespace is kept as plain text so word gaps stay visible as gaps.
 *  The hidden state lives on the row (.sentence-row.is-hidden), so it also drives
 *  the per-word blocks in the score result.
 *
 *  Every known split-point pointer (getSplitPointers() below -- Azure's own
 *  word boundaries, any manually-confirmed point, or textSplitPoints()'s
 *  synthetic fallback when there's neither) gets a small clickable
 *  `.split-pointer` triangle spliced right into the text at that character
 *  gap -- since getSplitPointers() always has something to offer now, every
 *  splittable position already has a visible triangle, and that triangle is
 *  the only way to split (there's no separate click-anywhere-in-the-text
 *  marker UI; a version of this file used to have one, back when Azure word
 *  boundaries were sparse enough that a mid-text click could easily land
 *  somewhere with no nearby triangle -- with one at literally every
 *  position now, that UI could only ever say "click a triangle instead"). */
export function buildTextEl(sentence) {
  const el = document.createElement('div');
  el.className = 'row-text';
  const inner = document.createElement('span');
  inner.className = 'row-text-inner';
  const chars = Array.from(sentence.text);
  const pointersByIndex = new Map();
  for (const p of getSplitPointers(sentence)) {
    if (!pointersByIndex.has(p.charIndex)) pointersByIndex.set(p.charIndex, []);
    pointersByIndex.get(p.charIndex).push(p);
  }
  for (let i = 0; i <= chars.length; i++) {
    const here = pointersByIndex.get(i);
    if (here) {
      for (const p of here) {
        // Zero-size inline anchor at this exact character gap, so the
        // triangle itself (position: absolute, see styles.css) floats above
        // the text without taking up any horizontal space of its own --
        // otherwise every triangle would shove the following characters
        // apart and disturb line wrapping, which is exactly what a plain
        // inline element here would do.
        const anchor = document.createElement('span');
        anchor.className = 'split-pointer-anchor';
        const tri = document.createElement('button');
        tri.type = 'button';
        tri.className = `split-pointer split-pointer-${p.kind}`;
        tri.textContent = '▾'; // ▾
        tri.title = p.kind === 'word' ? 'Split here (exact Azure word boundary)'
          : p.kind === 'manual' ? 'Split here (your confirmed point)'
            : 'Split here';
        tri.dataset.charIndex = String(i);
        tri.dataset.ms = p.ms == null ? '' : String(p.ms);
        anchor.appendChild(tri);
        inner.appendChild(anchor);
      }
    }
    if (i === chars.length) break;
    const ch = chars[i];
    if (/\s/.test(ch)) {
      inner.appendChild(document.createTextNode(ch));
    } else {
      const charEl = document.createElement('span');
      charEl.className = 'row-char';
      charEl.textContent = ch;
      // Lets Speak-time word highlighting (row.js) look up this exact
      // character by its position in sentence.text, the same charStart/
      // charEnd units sentence.words[] and getSplitPointers() already use.
      charEl.dataset.charIndex = String(i);
      inner.appendChild(charEl);
    }
  }
  el.appendChild(inner);
  return el;
}

// ---- Click-to-split ----
// Every splittable position already carries its own clickable triangle
// (buildTextEl() above); the row's body click handler (row.js) just delegates
// to whichever `.split-pointer` triangle was clicked and calls splitAtPointer()
// below directly -- there's no separate click-anywhere marker/hint step.

/** Redraw just one sentence's text element in place (used after something
 *  that changes what buildTextEl() would draw for it -- e.g. its language
 *  toggling, which changes textSplitPoints()'s synthetic-triangle
 *  granularity -- so the rest of the row -- buttons, status, score -- is
 *  left untouched). */
export function refreshRowText(sentence) {
  if (!sentence._textEl) return;
  const fresh = buildTextEl(sentence);
  sentence._textEl.replaceWith(fresh);
  sentence._textEl = fresh;
}

/**
 * Every known exact split point for a sentence, sorted by character
 * position: one per Azure word boundary (sentence.words -- see
 * resegmentByPunctuation() in audio-import.js) plus one per manually
 * confirmed point (sentence.manualPoints -- currently only ever populated by
 * mergeSelectedSentences()'s seam-preserving logic above, when two
 * previously-split sentences are merged back together). Both are real, exact
 * timestamps -- never a character-ratio guess -- which is what lets a click
 * directly on one (row.js) split immediately with no confirmation step:
 * there's nothing to verify by ear that isn't already known to be correct.
 * A sentence with neither (a plain text Split, or an import Azure returned
 * no per-word timing for) falls back to textSplitPoints() below instead of
 * offering nothing -- same triangle, same instant-split click, just no
 * timestamp behind it. Endpoints (charIndex 0 or the full text length) are
 * excluded -- splitting there would leave one side empty.
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
 * associate a time with -- splitAtPointer() below only reads `ms` when
 * there's real reference audio to slice, which by construction a sentence
 * that reaches this function never has anything reliable to offer anyway.
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

/** The pointer (if any) sitting exactly at `charIndex` -- used to tell "click
 *  landed on a known boundary" apart from "click landed between two". */
export function findPointerAt(sentence, charIndex) {
  return getSplitPointers(sentence).find((p) => p.charIndex === charIndex) || null;
}

/** Slice a decoded source at an EXACT ms split point -- no snapping/guessing,
 *  since every caller of this already knows the split point is either a real
 *  Azure word boundary or a user-confirmed manual point. Returns null if the
 *  split point would leave either side with zero duration. */
function sliceExactSplit(decoded, rangeStartMs, rangeEndMs, splitMs) {
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
function partitionWords(words, charIndex) {
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
function partitionManualPoints(manualPoints, charIndex) {
  const left = [];
  const right = [];
  for (const p of manualPoints || []) {
    if (p.charIndex < charIndex) left.push(p);
    else if (p.charIndex > charIndex) right.push({ ...p, charIndex: p.charIndex - charIndex });
  }
  return { left, right };
}

/** Build the two new sentences a split produces and swap them into
 *  `sentences` in place of the original -- shared by every split path below
 *  (exact-pointer, manual-fine-tune, text-only). `refs` is the
 *  {left,right:{blob,sourceOffsetMs,sourceDurationMs}} pair from
 *  sliceExactSplit() above, or null to leave both halves without reference
 *  audio. Recording/score never carry over, same as Merge -- there's no way
 *  to know which portion of a user recording corresponds to either half. */
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
 * boundary, a previously-confirmed manual point, or (getSplitPointers()'s
 * textSplitPoints() fallback above) a plain character/word boundary with no
 * audio behind it at all, never a guess. Re-slices both halves straight from
 * the pristine source at that exact ms when there's real reference audio to
 * slice (sentence.referenceSource === 'import'); a sentence with none --
 * every plain text Split, plus any import Azure returned no per-word data
 * for -- just splits the text, the same single code path either way.
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

/** Refresh the label of a sentence's hide toggle button. */
export function paintHidden(sentence) {
  if (!sentence._hideBtn) return;
  sentence._hideBtn.textContent = sentence.hidden ? 'Show' : 'Hide';
  sentence._hideBtn.setAttribute('aria-pressed', String(sentence.hidden));
}

/** Set a sentence's hidden state and sync the DOM. */
export function applyHidden(sentence, value) {
  sentence.hidden = value;
  if (sentence._row) sentence._row.classList.toggle('is-hidden', value);
  paintHidden(sentence);
}
