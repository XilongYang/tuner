// DOM-level coverage for sentence-panel/vocab-picker.js's Confirm handler --
// specifically the "retry after a partial mid-loop failure" fix: a first
// draft looped store.addVocabOccurrence() calls with no memory of which
// groups had already succeeded, so if a later group's write failed (leaving
// Confirm/Cancel re-enabled for the user to retry, the natural recovery
// action) a retry re-ran the WHOLE loop from scratch, including groups that
// had already durably landed -- creating a duplicate occurrence for each of
// them (addVocabOccurrence() always appends a fresh occurrence, it has no
// idempotency check of its own). This file drives the real popup DOM
// (clicks, not calling internal functions directly) against a fake
// store.addVocabOccurrence() that fails once, to prove a retry resumes
// instead of restarting.
//
// vocab-picker.js only ever touches `store.addVocabOccurrence` through the
// `* as store` namespace import, so mocking just that one named export is
// enough -- everything else callers might reach through `store` in other
// files is irrelevant to this one.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
let failNextFooOnce = false;

mock.module('../js/store/index.js', {
  namedExports: {
    addVocabOccurrence: async (text, lang, source) => {
      calls.push(text);
      if (text === 'foo' && failNextFooOnce) {
        failNextFooOnce = false;
        throw new Error('simulated write failure');
      }
      return { id: text, text, lang, sources: [{ ...source, occurrenceId: `occ-${calls.length}` }] };
    },
  },
});

// Dynamic import()s, not static ones -- see azure-sync.test.mjs's module
// comment for exactly why a static import here would silently defeat the
// mock.module() call above (this file needs no fake-indexeddb: vocab-picker.js
// never touches IndexedDB directly, only through the now-mocked store module).
await import('./setup-dom.mjs');
// vocab-picker.js transitively imports tts-player.js (via vocab-audio.js's
// resolveVocabAudio(), used for the synthesized-audio fallback), which does
// `export const ttsAudio = new Audio();` at module top level -- jsdom (via
// setup-dom.mjs) doesn't define a real Audio, and this file's tests never
// need actual playback, so a minimal stub is enough just to satisfy the
// import.
global.Audio ??= class {};
const { showVocabPicker } = await import('../js/sentence-panel/vocab-picker.js');

beforeEach(() => {
  calls.length = 0;
  failNextFooOnce = false;
});

/** Poll until `cond()` is truthy or give up -- needed because the Confirm
 *  handler is async but element.click() doesn't return anything awaitable;
 *  this drains enough microtask/macrotask turns for it to actually finish. */
async function waitFor(cond, tries = 50) {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('waitFor: condition never became true');
}

test('showVocabPicker Confirm: retrying after a mid-loop failure resumes instead of duplicating the already-succeeded group', async () => {
  const sentence = {
    id: 'sent1', text: 'hello world foo', lang: 'en', referenceSource: null, words: null,
  };
  const resultPromise = showVocabPicker(sentence);

  // Select word 0 ("hello") and word 2 ("foo") -- non-adjacent, so this
  // becomes two separate groups: confirming records "hello" first, then
  // "foo" second.
  const words = document.querySelectorAll('.vocab-picker-word');
  assert.equal(words.length, 3, 'hello / world / foo');
  words[0].click();
  words[2].click();

  const confirmBtn = [...document.querySelectorAll('.modal-actions .btn')].find((b) => b.textContent === 'Confirm');
  const status = document.querySelector('.vocab-picker-status');

  failNextFooOnce = true; // the second group's first attempt will throw
  confirmBtn.click();

  await waitFor(() => !confirmBtn.disabled); // handler re-enables the buttons once the throw is caught
  assert.match(status.textContent, /Failed to add vocab/);
  assert.deepEqual(calls, ['hello', 'foo'], '"hello" succeeded, "foo" was attempted and failed');

  // Retry: "foo" now succeeds. Must NOT re-call addVocabOccurrence for
  // "hello" a second time.
  confirmBtn.click();
  const count = await resultPromise;

  assert.equal(count, 2, 'both groups counted once resolved');
  assert.deepEqual(calls, ['hello', 'foo', 'foo'], '"hello" was only ever recorded once, across both attempts');
});

test('showVocabPicker Confirm: the word selection is frozen once a Confirm attempt starts, so a retry can\'t desync from the resumed loop', async () => {
  const sentence = {
    id: 'sent1', text: 'hello world foo', lang: 'en', referenceSource: null, words: null,
  };
  showVocabPicker(sentence);

  const words = document.querySelectorAll('.vocab-picker-word');
  words[0].click();
  words[2].click();
  const confirmBtn = [...document.querySelectorAll('.modal-actions .btn')].find((b) => b.textContent === 'Confirm');

  failNextFooOnce = true;
  confirmBtn.click();
  await waitFor(() => !confirmBtn.disabled);

  // Attempt to change the selection after the failed attempt -- must be a no-op.
  words[1].classList.contains('is-selected'); // sanity: not selected yet
  words[1].click();
  assert.ok(!words[1].classList.contains('is-selected'), 'clicking a word after a Confirm attempt has started does not select it');
});
