// Vocab library sidebar: open/close state (mutually exclusive with the
// History sidebar -- opening either closes the other, same as Aspen asked:
// a Panel the same size as History, mutually exclusive with it, as the
// vocab library's viewing UI), and the list rendering itself. Scope is
// deliberately minimal per Aspen's own "this much is enough for now": list
// every entry, play a random occurrence's own recorded/synthesized clip, play
// the full source sentence's own recording/reference audio, view which
// sentence(s) it came from, and delete an entry outright -- no per-occurrence
// delete, no editing/review/quiz mode from here.
//
// Circular with history-panel/panel.js (each imports the other's close
// function to enforce mutual exclusion) -- safe, same as every other
// panel-pair cycle in this codebase: both sides only call into each other
// from inside functions, never at module-evaluation time.

import { els } from '../state.js';
import * as store from '../store/index.js';
import { player } from '../tts-player.js';
import { scheduleAutoSync } from '../sync/index.js';
import { closeHistorySidebar } from '../history-panel/index.js';

let vocabPanelOpen = false;

/** Re-render the list if the sidebar is currently open (e.g. after a sync brings in new entries). */
export function refreshVocabPanelIfOpen() {
  if (vocabPanelOpen) renderVocabList();
}

export function openVocabSidebar() {
  vocabPanelOpen = true;
  els.vocabSidebar.classList.add('is-open');
  els.toggleVocabPanel.setAttribute('aria-expanded', 'true');
  closeHistorySidebar();
  renderVocabList();
}

export function closeVocabSidebar() {
  vocabPanelOpen = false;
  els.vocabSidebar.classList.remove('is-open');
  els.toggleVocabPanel.setAttribute('aria-expanded', 'false');
}

function emptyMsg(text) {
  const p = document.createElement('p');
  p.className = 'vocab-empty';
  p.textContent = text;
  return p;
}

function formatAddedAt(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

/** Play `blob` through the shared tts-player.js `player` (same start/stop/
 *  toggle-if-already-playing behavior used everywhere else in the app),
 *  tying the Blob URL's lifetime to the Audio element's own playback. */
function playBlob(blob, btn) {
  if (player.isActive(btn)) { player.stop(); return; }
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  const revoke = () => URL.revokeObjectURL(url);
  audio.addEventListener('ended', revoke, { once: true });
  audio.addEventListener('pause', revoke, { once: true });
  player.start(audio, btn);
}

/** Play a random audio-bearing occurrence of `entry` (per Aspen's own rule:
 *  randomly pick one of the sources' own audio when replaying) -- a no-op if
 *  every occurrence is text-only. */
function playRandomOccurrence(entry, btn) {
  const withAudio = (entry.sources || []).filter((s) => s.hasAudio && s.audioBlob);
  if (!withAudio.length) return;
  const source = withAudio[Math.floor(Math.random() * withAudio.length)];
  playBlob(source.audioBlob, btn);
}

/**
 * Play the full ORIGINAL sentence `s` was recorded from -- its session's own
 * referenceBlob (the Speak/synthesized or import-sliced reference clip),
 * NEVER the user's own recordingBlob (their own reading of it): the point is
 * to hear the correct/model pronunciation of the whole sentence, same reason
 * resolveVocabAudio() (vocab-audio.js) only ever sources the per-word clip
 * from reference audio too. Distinct from playRandomOccurrence()/the
 * entry-level play button above, which only ever play the short standalone
 * word/phrase clip sliced out of that sentence. Looked up lazily on click
 * rather than pre-fetched for every row, since the session/sentence a source
 * points at may since have been deleted, moved, or edited --
 * sentenceTextSnapshot is what stays displayable regardless, but the audio
 * itself can only be resolved live.
 */
async function playSourceSentence(s, btn) {
  if (!s.sessionId) return;
  btn.disabled = true;
  try {
    const session = await store.getSession(s.sessionId);
    const sentence = session?.sentences?.find((sen) => sen.id === s.sentenceId);
    const blob = sentence?.referenceBlob;
    if (!blob) {
      btn.title = 'Reference audio for the original sentence is no longer available.';
      return;
    }
    playBlob(blob, btn);
  } finally {
    btn.disabled = false;
  }
}

/** The user's own "remove this word" action: deletes the entry (and records
 *  a tombstone, store/vocab.js's deleteVocabEntry()) so the deletion sticks
 *  through the next sync instead of just coming back down from Azure --
 *  same confirm+scheduleAutoSync() shape history-panel/actions.js's
 *  confirmDeleteSession() uses, just a single confirm() rather than that
 *  file's "Clear all" two-step countdown, since this only ever removes one
 *  entry at a time. */
async function deleteEntry(entry, btn) {
  if (!confirm(`Delete vocab entry "${entry.text}"? This cannot be undone.`)) return;
  btn.disabled = true;
  try {
    await store.deleteVocabEntry(entry.id);
    await renderVocabList();
    scheduleAutoSync();
  } catch (err) {
    alert('Failed to delete vocab entry: ' + err.message);
    btn.disabled = false;
  }
}

function buildEntryRow(entry) {
  const row = document.createElement('div');
  row.className = 'vocab-entry';

  const head = document.createElement('div');
  head.className = 'vocab-entry-head';

  const text = document.createElement('span');
  text.className = 'vocab-entry-text';
  text.textContent = entry.text;
  head.appendChild(text);

  const count = document.createElement('span');
  count.className = 'vocab-entry-count';
  const n = (entry.sources || []).length;
  count.textContent = `${n} occurrence${n === 1 ? '' : 's'}`;
  head.appendChild(count);

  const hasAnyAudio = (entry.sources || []).some((s) => s.hasAudio && s.audioBlob);
  const playBtn = document.createElement('button');
  playBtn.className = 'btn vocab-play-btn';
  playBtn.type = 'button';
  playBtn.textContent = '▶';
  playBtn.disabled = !hasAnyAudio;
  playBtn.title = hasAnyAudio ? 'Play a random occurrence\'s audio' : 'No audio available to play';
  playBtn.addEventListener('click', () => playRandomOccurrence(entry, playBtn));
  head.appendChild(playBtn);

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'btn vocab-sources-toggle';
  toggleBtn.type = 'button';
  toggleBtn.textContent = 'Sources';
  head.appendChild(toggleBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn danger vocab-delete-btn';
  deleteBtn.type = 'button';
  deleteBtn.textContent = 'Delete';
  deleteBtn.title = 'Delete this vocab entry';
  deleteBtn.addEventListener('click', () => deleteEntry(entry, deleteBtn));
  head.appendChild(deleteBtn);

  row.appendChild(head);

  const sourcesWrap = document.createElement('div');
  sourcesWrap.className = 'vocab-entry-sources';
  sourcesWrap.hidden = true;
  for (const s of entry.sources || []) {
    const line = document.createElement('div');
    line.className = 'vocab-source-line';

    const top = document.createElement('div');
    top.className = 'vocab-source-top';
    const snippet = document.createElement('span');
    snippet.className = 'vocab-source-snippet';
    // sentenceTextSnapshot is captured at record time, so this still displays
    // correctly even if the original session/sentence was since deleted or
    // edited -- see store/vocab.js's doc comment on addVocabOccurrence().
    snippet.textContent = s.sentenceTextSnapshot || '(original sentence no longer available)';
    top.appendChild(snippet);

    // Plays the full ORIGINAL sentence (its session's recording/reference
    // audio), not the short word/phrase clip the entry-level play button
    // above uses -- resolved lazily since the session/sentence may since
    // have been deleted, moved, or edited. Always shown when there's a
    // session/sentence to look up; whether it actually has audio is only
    // known once clicked.
    if (s.sessionId && s.sentenceId) {
      const sentenceBtn = document.createElement('button');
      sentenceBtn.className = 'btn vocab-source-play-btn';
      sentenceBtn.type = 'button';
      sentenceBtn.textContent = '▶';
      sentenceBtn.title = 'Play the original sentence';
      sentenceBtn.addEventListener('click', () => playSourceSentence(s, sentenceBtn));
      top.appendChild(sentenceBtn);
    }
    line.appendChild(top);

    const meta = document.createElement('span');
    meta.className = 'vocab-source-meta';
    meta.textContent = [s.hasAudio ? '🔊' : '', formatAddedAt(s.addedAt)].filter(Boolean).join(' · ');
    line.appendChild(meta);
    sourcesWrap.appendChild(line);
  }
  row.appendChild(sourcesWrap);

  toggleBtn.addEventListener('click', () => {
    sourcesWrap.hidden = !sourcesWrap.hidden;
    toggleBtn.textContent = sourcesWrap.hidden ? 'Sources' : 'Hide sources';
  });

  return row;
}

// Same race-guard token history-panel/actions.js's renderHistoryTree() uses:
// refreshVocabPanelIfOpen() can be triggered by a sync's uiHooks call at
// basically any time, including while deleteEntry()'s own renderVocabList()
// call is still awaiting store.listVocab() -- without this, the two async
// fetches can resolve out of call order and paint a stale list over a newer
// one (e.g. the just-deleted entry flashing back in until the next repaint).
let vocabRenderToken = 0;

/** Fetch and paint the vocab list. No store access outside this function --
 *  same "fetch-then-paint in one place" convention history-panel/actions.js's
 *  renderHistoryTree() follows, including its overlapping-call race guard. */
async function renderVocabList() {
  const token = ++vocabRenderToken;
  if (!store.isSupported()) {
    if (token !== vocabRenderToken) return;
    els.vocabList.innerHTML = '';
    els.vocabList.appendChild(emptyMsg("This browser doesn't support local storage (IndexedDB unavailable)."));
    return;
  }
  let entries;
  try {
    entries = await store.listVocab();
  } catch (err) {
    if (token !== vocabRenderToken) return; // a newer call already owns the DOM from here on
    els.vocabList.innerHTML = '';
    els.vocabList.appendChild(emptyMsg('Failed to load vocabulary: ' + err.message));
    return;
  }
  if (token !== vocabRenderToken) return; // superseded while this call was in flight
  els.vocabList.innerHTML = '';
  if (!entries.length) {
    els.vocabList.appendChild(emptyMsg('No vocab yet — click "Add vocab" in the sentence panel to add one.'));
    return;
  }
  for (const entry of entries) {
    els.vocabList.appendChild(buildEntryRow(entry));
  }
}

/** Wire the sidebar's open/close controls. */
export function initVocabPanel() {
  els.toggleVocabPanel.addEventListener('click', () => {
    if (vocabPanelOpen) closeVocabSidebar();
    else openVocabSidebar();
  });
  els.vocabCloseBtn.addEventListener('click', closeVocabSidebar);
}
