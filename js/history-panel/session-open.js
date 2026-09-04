// Load a saved session back onto the screen (openSession), and reconcile
// the live sentence list with an incoming post-sync-merge copy of the
// session already on screen (applyIncomingSessionUpdate) -- see its own
// docstring below for why that's not just a full openSession() reload.

import { Recorder } from '../recorder.js';
import {
  els, sentences, setSentences, setCurrentSessionId, isSentenceBusy,
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
  if (item.splitMode) els.splitMode.value = item.splitMode;

  setSentences((item.sentences || []).map(makeLiveSentence));

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
    if (els.input.value !== nextInput) els.input.value = nextInput;
  }
  if (refreshed.splitMode && els.splitMode.value !== refreshed.splitMode) {
    els.splitMode.value = refreshed.splitMode;
  }

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
      JSON.stringify(live.assessment || null) === JSON.stringify(rs.assessment || null);
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
    render();
  }
  setCurrentSessionId(refreshed.id);
  refreshHistoryTreeIfOpen();
}
