// End-to-end smoke test for the vocab library sidebar: opening it is
// mutually exclusive with the History sidebar (either direction), and it
// lists whatever's in the vocab store, with a working play button (random
// audio-bearing source) and a "Sources" toggle showing sentenceTextSnapshot
// per occurrence.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');
await page.waitForLoadState('networkidle');

// --- 1. Empty state. ---
await page.click('#toggle-vocab-panel');
await page.waitForTimeout(100);
const emptyState = await page.evaluate(() => ({
  vocabOpen: document.getElementById('vocab-sidebar').classList.contains('is-open'),
  emptyText: document.querySelector('.vocab-empty')?.textContent || null,
}));
console.log('empty state:', JSON.stringify(emptyState));

// --- 2. Mutual exclusion: opening History while vocab is open closes vocab, and vice versa. ---
await page.click('#toggle-history-panel');
await page.waitForTimeout(100);
const afterHistoryOpen = await page.evaluate(() => ({
  historyOpen: document.getElementById('history-sidebar').classList.contains('is-open'),
  vocabOpen: document.getElementById('vocab-sidebar').classList.contains('is-open'),
}));
console.log('after opening History (vocab was open):', JSON.stringify(afterHistoryOpen));

await page.click('#toggle-vocab-panel');
await page.waitForTimeout(100);
const afterVocabReopen = await page.evaluate(() => ({
  historyOpen: document.getElementById('history-sidebar').classList.contains('is-open'),
  vocabOpen: document.getElementById('vocab-sidebar').classList.contains('is-open'),
}));
console.log('after opening vocab again (History was open):', JSON.stringify(afterVocabReopen));

// --- 3. Seed two vocab entries directly (one with audio, one without) and
// re-render, then check the list/play/sources UI. ---
const listResult = await page.evaluate(async () => {
  const store = await import('/js/store/index.js');
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const audioBlob = new Blob([bytes], { type: 'audio/wav' });
  await store.addVocabOccurrence('hello', 'en', {
    sessionId: 's1', sentenceId: 'sent1', sentenceTextSnapshot: 'Hello there, friend.', audioBlob,
  });
  await store.addVocabOccurrence('textonly', 'en', {
    sessionId: 's2', sentenceId: 'sent2', sentenceTextSnapshot: 'A text-only occurrence.', audioBlob: null,
  });

  const panel = await import('/js/vocab-panel/index.js');
  panel.openVocabSidebar();
  await new Promise((r) => setTimeout(r, 50));

  const entries = Array.from(document.querySelectorAll('.vocab-entry')).map((row) => ({
    text: row.querySelector('.vocab-entry-text').textContent,
    count: row.querySelector('.vocab-entry-count').textContent,
    playDisabled: row.querySelector('.vocab-play-btn').disabled,
  }));

  // Expand the first entry's sources and read the snapshot text back.
  const firstToggle = document.querySelector('.vocab-entry .vocab-sources-toggle');
  firstToggle.click();
  await new Promise((r) => setTimeout(r, 20));
  const firstSourcesHidden = document.querySelector('.vocab-entry-sources').hidden;
  const firstSnippet = document.querySelector('.vocab-source-snippet').textContent;

  // Click Play on the audio-bearing entry -- just confirm it doesn't throw
  // and marks the button active (no real audio decoding needed in headless
  // Chromium for an <audio> play() call against an arbitrary Blob URL to at
  // least attempt playback without erroring synchronously).
  const playBtn = document.querySelector('.vocab-play-btn:not(:disabled)');
  let playThrew = false;
  try { playBtn.click(); } catch { playThrew = true; }
  await new Promise((r) => setTimeout(r, 50));

  return {
    entries, firstSourcesHidden, firstSnippet, playThrew,
  };
});
console.log('list result:', JSON.stringify(listResult));

// --- 4. Per-source "play the original sentence" button: present whenever a
// source carries a sessionId/sentenceId, plays the sentence's own reference
// (Speak/synthesized) audio when it exists, and fails gracefully (no throw,
// clear title) both when the sentence has only the user's own recording
// (never used as a fallback -- the point is to hear the reference
// pronunciation, not the user's own reading of it) and when the session no
// longer exists at all. ---
const sourcePlayResult = await page.evaluate(async () => {
  const store = await import('/js/store/index.js');
  const referenceBlob = new Blob([new Uint8Array([9, 9, 9])], { type: 'audio/wav' });
  const recordingBlob = new Blob([new Uint8Array([7, 7, 7])], { type: 'audio/wav' });
  const sessionId = await store.createSession({
    inputText: 'source sentence still exists',
    splitMode: 'auto',
    sentences: [
      {
        id: 'sentA', text: 'source sentence still exists', lang: 'en', hidden: false, referenceBlob,
      },
      {
        id: 'sentB', text: 'recording only, no reference', lang: 'en', hidden: false, recordingBlob,
      },
    ],
  });
  await store.addVocabOccurrence('sourceword', 'en', {
    sessionId, sentenceId: 'sentA', sentenceTextSnapshot: 'source sentence still exists', audioBlob: null,
  });
  // Has a real session/sentence, but only a recordingBlob -- must NOT fall
  // back to it; still reports "not available" since referenceBlob is what's missing.
  await store.addVocabOccurrence('recordingonlyword', 'en', {
    sessionId, sentenceId: 'sentB', sentenceTextSnapshot: 'recording only, no reference', audioBlob: null,
  });
  // Points at a session that was never created -- exercises the "no longer available" path.
  await store.addVocabOccurrence('goneword', 'en', {
    sessionId: 'does-not-exist', sentenceId: 'sentX', sentenceTextSnapshot: 'gone sentence', audioBlob: null,
  });

  const panel = await import('/js/vocab-panel/index.js');
  panel.openVocabSidebar();
  await new Promise((r) => setTimeout(r, 50));

  document.querySelectorAll('.vocab-entry .vocab-sources-toggle').forEach((btn) => btn.click());
  await new Promise((r) => setTimeout(r, 20));

  const findPlayBtn = (entryText) => Array.from(document.querySelectorAll('.vocab-entry'))
    .find((row) => row.querySelector('.vocab-entry-text').textContent === entryText)
    .querySelector('.vocab-source-play-btn');

  const buttonCount = document.querySelectorAll('.vocab-source-play-btn').length;

  const existingBtn = findPlayBtn('sourceword');
  let existingThrew = false;
  try { existingBtn.click(); } catch { existingThrew = true; }
  await new Promise((r) => setTimeout(r, 80));
  const existingDisabledAfter = existingBtn.disabled;
  const existingTitleAfter = existingBtn.title;

  const recordingOnlyBtn = findPlayBtn('recordingonlyword');
  let recordingOnlyThrew = false;
  try { recordingOnlyBtn.click(); } catch { recordingOnlyThrew = true; }
  await new Promise((r) => setTimeout(r, 80));
  const recordingOnlyTitleAfter = recordingOnlyBtn.title;

  const goneBtn = findPlayBtn('goneword');
  let goneThrew = false;
  try { goneBtn.click(); } catch { goneThrew = true; }
  await new Promise((r) => setTimeout(r, 80));
  const goneTitleAfter = goneBtn.title;

  return {
    buttonCount,
    existingThrew,
    existingDisabledAfter,
    existingTitleAfter,
    recordingOnlyThrew,
    recordingOnlyTitleAfter,
    goneThrew,
    goneTitleAfter,
  };
});
console.log('source play result:', JSON.stringify(sourcePlayResult));

// --- 5. Delete: removes the entry from IndexedDB, records a tombstone, and
// repaints the list without it; declining the confirm leaves it untouched. ---
const deleteResult = await page.evaluate(async () => {
  const store = await import('/js/store/index.js');
  await store.addVocabOccurrence('deleteme', 'en', { sentenceTextSnapshot: 'delete this one' });

  const panel = await import('/js/vocab-panel/index.js');
  panel.openVocabSidebar();
  await new Promise((r) => setTimeout(r, 50));

  const findRow = (entryText) => Array.from(document.querySelectorAll('.vocab-entry'))
    .find((row) => row.querySelector('.vocab-entry-text').textContent === entryText);

  const beforeCount = (await store.listVocab()).length;

  // Decline first -- entry must survive.
  const originalConfirm = window.confirm;
  window.confirm = () => false;
  findRow('deleteme').querySelector('.vocab-delete-btn').click();
  await new Promise((r) => setTimeout(r, 50));
  const afterDeclineCount = (await store.listVocab()).length;
  const rowStillInDom = !!findRow('deleteme');

  // Now accept -- entry must be gone from both the store and the repainted list.
  window.confirm = () => true;
  findRow('deleteme').querySelector('.vocab-delete-btn').click();
  await new Promise((r) => setTimeout(r, 80));
  window.confirm = originalConfirm;

  const afterAcceptCount = (await store.listVocab()).length;
  const rowGoneFromDom = !findRow('deleteme');
  const tombstones = await store.listTombstones();
  const hasTombstone = tombstones.some((t) => t.kind === 'vocab' && t.targetId === 'deleteme');

  return {
    beforeCount, afterDeclineCount, rowStillInDom, afterAcceptCount, rowGoneFromDom, hasTombstone,
  };
});
console.log('delete result:', JSON.stringify(deleteResult));

await browser.close();
console.log('LOGS:', logs);
