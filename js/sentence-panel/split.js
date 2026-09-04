// Split action: turns the pasted input text into the sentence list and kicks
// off a new saved session. Also owns the hidden-text toggle helpers, since
// both Split (defaulting to the global switch) and the per-row hide button
// (in ./row.js) need to paint/apply the same hidden state.

import { segment, splitBySlash } from '../segment.js';
import { detectLang } from '../lang.js';
import { Recorder } from '../recorder.js';
import * as store from '../store/index.js';
import {
  els,
  sentences,
  setSentences,
  setCurrentSessionId,
  globalHideText,
  sentenceToRecord,
} from '../state.js';
import { refreshHistoryTreeIfOpen } from '../history-panel/index.js';
import { scheduleAutoSync } from '../sync/index.js';
import { renderRow } from './row.js';

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

// ---- Sentence list ----

export async function handleSplit() {
  const parts = els.splitMode.value === 'manual'
    ? splitBySlash(els.input.value)
    : segment(els.input.value);
  stopActiveWordRetest();
  // Release resources from the previous recordings
  for (const s of sentences) s.recorder.dispose();

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
  })));

  render();

  // Each Split starts a new saved session (local only, via IndexedDB).
  setCurrentSessionId(null);
  if (sentences.length && store.isSupported()) {
    try {
      setCurrentSessionId(await store.createSession({
        inputText: els.input.value,
        splitMode: els.splitMode.value,
        sentences: sentences.map(sentenceToRecord),
      }));
      refreshHistoryTreeIfOpen();
      scheduleAutoSync();
    } catch (err) {
      console.warn('Failed to save session locally:', err);
    }
  }
}

export function render() {
  els.list.innerHTML = '';
  els.count.textContent = sentences.length
    ? `${sentences.length} ${sentences.length > 1 ? 'sentences' : 'sentence'}`
    : '';

  if (sentences.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-hint';
    empty.textContent = 'Paste text and click Split; sentences will appear here, one per line.';
    els.list.appendChild(empty);
    return;
  }

  sentences.forEach((sentence, index) => {
    els.list.appendChild(renderRow(sentence, index));
  });
}

/** Build the sentence text element; wrap the whole sentence in an inline span so
 *  that when hidden it renders as a continuous black bar per line.
 *  The hidden state lives on the row (.sentence-row.is-hidden), so it also drives
 *  the per-word blocks in the score result. */
export function buildTextEl(sentence) {
  const el = document.createElement('div');
  el.className = 'row-text';
  const inner = document.createElement('span');
  inner.className = 'row-text-inner';
  inner.textContent = sentence.text;
  el.appendChild(inner);
  return el;
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
