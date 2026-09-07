// Load a saved session back onto the screen (openSession), and reconcile
// the live sentence list with an incoming post-sync-merge copy of the
// session already on screen (applyIncomingSessionUpdate) -- see its own
// docstring below for why that's not just a full openSession() reload.

import { Recorder } from '../recorder.js';
import {
  els, sentences, setSentences, setCurrentSessionId, setCurrentSplitMode, isSentenceBusy,
  refreshInputMaskOverlay, setSourceAudio, reflectGlobalHideCheckbox,
} from '../state.js';
import { render } from '../sentence-panel/index.js';
import { refreshHistoryTreeIfOpen } from './panel.js';

/**
 * Build a live, on-screen sentence object from a stored/incoming record.
 * Shared by openSession() (full reload) and applyIncomingSessionUpdate()
 * (partial, sync-driven refresh of the session already on screen).
 */
function makeLiveSentence(s) {
  return {
    // Keep the sentence's original id stable: it's what ties a saved
    // recording to its blob path on Azure (tuner/recordings/<sessionId>/<sentenceId>.wav).
    // Reassigning a fresh one here would orphan the old blob on the next sync.
    id: s.id ?? crypto.randomUUID(),
    text: s.text,
    lang: s.lang,
    hidden: s.hidden,
    recorder: new Recorder(),
    recordingUrl: s.recordingBlob ? URL.createObjectURL(s.recordingBlob) : null,
    recordingBlob: s.recordingBlob || null,
    recordingHash: s.recordingHash || null,
    referenceUrl: s.referenceBlob ? URL.createObjectURL(s.referenceBlob) : null,
    referenceBlob: s.referenceBlob || null,
    referenceHash: s.referenceHash || null,
    referenceSource: s.referenceSource || null,
    // Where this clip sits in the session's sourceAudioBlob (openSession()/
    // applyIncomingSessionUpdate() below set that from item.sourceAudioBlob)
    // -- see its doc comment in state.js.
    sourceOffsetMs: s.sourceOffsetMs ?? null,
    sourceDurationMs: s.sourceDurationMs ?? null,
    // Azure's per-word timestamps and any manually-confirmed split points
    // (sentence-panel/split.js's getSplitPointers()/buildTextEl() draw the
    // clickable triangles from these) -- without carrying them through here,
    // every triangle vanished the moment a session was reloaded (openSession,
    // i.e. a page refresh or reopening from History), even though they were
    // persisted to IndexedDB just fine; this function building the live
    // sentence objects was simply dropping the two fields on the floor.
    words: s.words || null,
    manualPoints: s.manualPoints || null,
    // Sentence-level sync version; not shown in the UI, just carried through
    // so a later persistSession() doesn't lose it and make everything look
    // freshly-changed to the next sync.
    updatedAt: s.updatedAt || null,
    assessment: s.assessment || null,
    assessmentHash: s.assessmentHash || null,
  };
}

/** Load a saved session back onto the screen, replacing whatever is currently shown. */
export function openSession(item) {
  for (const s of sentences) s.recorder.dispose();

  els.input.value = item.inputText || '';
  setCurrentSplitMode(item.splitMode);
  setSourceAudio(item.sourceAudioBlob || null, item.sourceAudioHash || null);

  setSentences((item.sentences || []).map(makeLiveSentence));
  reflectGlobalHideCheckbox();

  setCurrentSessionId(item.id);
  render();
  refreshHistoryTreeIfOpen(); // keep the sidebar open; just update the "current" highlight
}

/**
 * Apply an incoming (post-sync-merge) copy of the session currently on
 * screen, without the disruption of a full openSession() reload: a sentence
 * whose persisted fields didn't actually change keeps its live object
 * (Recorder instance, open word-tip popover, everything) untouched, and a
 * BUSY sentence (mid-recording, or mid a word Retest -- see isSentenceBusy())
 * is left alone for this round even if it did change remotely; it picks up
 * that change on the next sync, once it's free. Session-level metadata is
 * applied the same way, skipping the practice-text box while it's focused.
 */
export function applyIncomingSessionUpdate(refreshed) {
  if (document.activeElement !== els.input) {
    const nextInput = refreshed.inputText || '';
    if (els.input.value !== nextInput) {
      els.input.value = nextInput;
      refreshInputMaskOverlay();
    }
  }
  if (refreshed.splitMode) setCurrentSplitMode(refreshed.splitMode);
  // Cheap (just a reference swap, no re-hashing) -- see sourceAudioHash's doc
  // comment in store/sessions.js's updateSession() for why it's safe to just
  // always apply this rather than diff it first.
  setSourceAudio(refreshed.sourceAudioBlob || null, refreshed.sourceAudioHash || null);

  const liveById = new Map(sentences.map((s) => [s.id, s]));
  let changed = false;
  const next = (refreshed.sentences || []).map((rs) => {
    const live = liveById.get(rs.id);
    if (!live) { changed = true; return makeLiveSentence(rs); }
    const samePersisted =
      live.text === rs.text &&
      live.lang === rs.lang &&
      live.hidden === rs.hidden &&
      (live.recordingHash || null) === (rs.recordingHash || null) &&
      (live.referenceHash || null) === (rs.referenceHash || null) &&
      (live.referenceSource || null) === (rs.referenceSource || null) &&
      JSON.stringify(live.assessment || null) === JSON.stringify(rs.assessment || null) &&
      JSON.stringify(live.words || null) === JSON.stringify(rs.words || null) &&
      JSON.stringify(live.manualPoints || null) === JSON.stringify(rs.manualPoints || null);
    if (samePersisted) return live;
    if (isSentenceBusy(rs.id)) return live; // leave it alone this round
    changed = true;
    live.recorder.dispose();
    return makeLiveSentence(rs);
  });
  // Sentences are never added to or removed from a session after Split (see
  // handleSplit), so `next` always has the same ids as the live array --
  // nothing to reconcile beyond what the map above already does.

  if (changed) {
    setSentences(next);
    reflectGlobalHideCheckbox();
    render();
  }
  setCurrentSessionId(refreshed.id);
  refreshHistoryTreeIfOpen();
}