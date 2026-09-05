// Sentence-list UI: DOM construction/painting and the row-selection
// interaction that lives entirely in the DOM (checkbox/Merge-bar state).
// Nothing in this file imports store or issues a network request -- the only
// way anything gets persisted is that split-actions.js calls back into
// render()/resetSelection() after it changes `sentences` and saves.
//
// Circular with row.js (which imports buildTextEl/paintHidden/applyHidden/
// toggleRowSelection/refreshRowText from here, while render() below imports
// renderRow from there) -- safe, same as the rest of this codebase's
// sentence-panel/history-panel cycles: both sides only call into each other
// from inside functions, never at module-evaluation time.

import { els, sentences, refreshInputMaskOverlay } from '../state.js';
import { renderRow } from './row.js';
import { getSplitPointers, isSessionLocked } from './split-geometry.js';

// ---- Row selection + Merge ----
// Which sentence rows are checked for merging, kept as a Set of sentence ids
// rather than indices since the array can be rebuilt (render()) while a
// selection is live. The one invariant this whole block maintains is that
// the selected ids are always a CONTIGUOUS run of `sentences` -- "不允许跳选"
// (no skip-selecting) -- enforced by disabling every checkbox that isn't
// adjacent to the current run (see updateSelectionUI()), so toggleRowSelection()
// itself never has to reject a click. Owned here (not split-actions.js)
// because every reader/writer of it -- render(), toggleRowSelection(),
// clearRowSelection() -- is itself pure DOM/interaction state with no store
// touch; split-actions.js's mergeSelectedSentences() reads/resets it through
// the exported getSelectedIndices()/resetSelection() below, the same way it
// already has to call back into render() to repaint.
let selectedIds = new Set();

export function getSelectedIndices() {
  const idxs = [];
  sentences.forEach((s, i) => { if (selectedIds.has(s.id)) idxs.push(i); });
  return idxs;
}

/** Drop the current selection (a full re-render always rebuilds fresh
 *  sentence objects/ids, so any previous selection is stale) and repaint. */
export function resetSelection() {
  selectedIds = new Set();
  updateSelectionUI();
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
 *  becomes "New Session" (split-actions.js's startNewSession()) since it
 *  would otherwise have no text to act on. */
function applyAudioSessionLock() {
  const locked = isSessionLocked();
  els.input.readOnly = locked;
  els.input.classList.toggle('is-locked', locked);
  if (els.inputLabel) els.inputLabel.hidden = locked;
  if (els.inputMaskWrap) els.inputMaskWrap.hidden = locked;
  els.clearInputBtn.hidden = locked;
  els.clearInputBtn.disabled = locked;
  els.splitBtn.textContent = locked ? 'New Session' : 'Split';
  // Import audio starts a fresh session from a file the same way Split
  // starts one from typed text -- once a session is already split (either
  // kind), there's no current session for it to import INTO; it would just
  // silently discard the one on screen and start another. Hide it here too,
  // alongside the other now-meaningless-until-New-Session controls above.
  if (els.audioImportBtn) els.audioImportBtn.hidden = locked;
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
 *  Every known split-point pointer (getSplitPointers() in split-geometry.js --
 *  Azure's own word boundaries, any manually-confirmed point, or its
 *  textSplitPoints() synthetic fallback when there's neither) gets a small
 *  clickable `.split-pointer` triangle spliced right into the text at that
 *  character gap -- since getSplitPointers() always has something to offer
 *  now, every splittable position already has a visible triangle, and that
 *  triangle is the only way to split (there's no separate click-anywhere-in-
 *  the-text marker UI; a version of this file used to have one, back when
 *  Azure word boundaries were sparse enough that a mid-text click could
 *  easily land somewhere with no nearby triangle -- with one at literally
 *  every position now, that UI could only ever say "click a triangle
 *  instead"). */
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
        // triangle itself (position: absolute, see css/sentence-panel/split-pointer.css) floats above
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

/** Refresh the label of a sentence's hide toggle button. */
export function paintHidden(sentence) {
  if (!sentence._hideBtn) return;
  sentence._hideBtn.textContent = sentence.hidden ? 'Show' : 'Hide';
  sentence._hideBtn.setAttribute('aria-pressed', String(sentence.hidden));
}

/** Set a sentence's hidden state and sync the DOM. Does not persist -- the
 *  caller (row.js) calls state.js's persistSession() itself afterward. */
export function applyHidden(sentence, value) {
  sentence.hidden = value;
  if (sentence._row) sentence._row.classList.toggle('is-hidden', value);
  paintHidden(sentence);
}
