// Entry point: wires the Credentials panel and bootstraps the app. Every
// domain (sentence list, History sidebar, cloud sync) lives in its own
// module; this file just imports and calls into them.

import * as store from './store/index.js';
import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  loadHideText,
  saveHideText,
  loadHistoryOpen,
  VOICE_OPTIONS,
  getVoice,
  saveVoice,
} from './config.js';
import { els, sentences, globalHideText, setGlobalHideText, persistSession } from './state.js';
import { render, handleSplit, applyHidden, stopActiveWordRetest } from './sentence-panel/index.js';
import { initHistoryPanel, openHistorySidebar } from './history-panel/index.js';
import { initBlobPanel } from './sync/index.js';

// ---- Credentials panel ----

// Two mutually exclusive states: has key → one-line status + Clear;
// no key → input fields + Save.
function updateKeyPanel() {
  const creds = loadCredentials();
  const has = !!creds;
  els.keyEntry.hidden = has;
  els.keySaved.hidden = !has;
  if (has) {
    els.keyStatus.textContent = `Key saved · Region = ${creds.region}`;
  }
}

function initKeyPanel() {
  els.saveKeyBtn.addEventListener('click', () => {
    const key = els.keyInput.value.trim();
    const region = els.regionInput.value.trim();
    if (!key || !region) {
      alert('Please enter both Key and Region');
      return;
    }
    saveCredentials(key, region);
    els.keyInput.value = '';
    updateKeyPanel();
  });

  els.clearKeyBtn.addEventListener('click', () => {
    clearCredentials();
    els.keyInput.value = '';
    els.regionInput.value = '';
    updateKeyPanel();
  });

  els.toggleKeyPanel.addEventListener('click', () => {
    els.keyPanel.hidden = !els.keyPanel.hidden;
    els.toggleKeyPanel.setAttribute('aria-expanded', String(!els.keyPanel.hidden));
  });

  initVoiceSelectors();
  updateKeyPanel();
}

/** Populate and wire the voice selectors; choices are written to localStorage. */
function initVoiceSelectors() {
  const wire = (selectEl, locale) => {
    for (const opt of VOICE_OPTIONS[locale]) {
      const o = document.createElement('option');
      o.value = opt.id;
      o.textContent = opt.label;
      selectEl.appendChild(o);
    }
    selectEl.value = getVoice(locale);
    selectEl.addEventListener('change', () => saveVoice(locale, selectEl.value));
  };
  wire(els.voiceJa, 'ja-JP');
  wire(els.voiceEn, 'en-US');
}

// ---- Initialization ----

async function init() {
  initKeyPanel();
  initBlobPanel();

  // One-time housekeeping: give any session left over from before ids were
  // switched to UUIDs a fresh one. Awaited before the history sidebar can
  // possibly render, so it never shows a stale legacy id.
  if (store.isSupported()) {
    try {
      const migrated = await store.migrateSessionIdsToUuid();
      if (migrated) console.info(`Migrated ${migrated} legacy session(s) to UUID ids.`);
    } catch (err) {
      console.warn('Legacy session id migration skipped:', err);
    }
    // Same idea, for sessions saved before inputTextHash existed -- without
    // this, such a session's first sync after upgrading treats its missing
    // hash as "nothing to resolve" and wipes its inputText back to null (see
    // backfillInputTextHashes()'s doc comment in store.js). Awaited before
    // any sync can possibly run, same reasoning as the UUID migration above.
    try {
      const backfilled = await store.backfillInputTextHashes();
      if (backfilled) console.info(`Backfilled inputTextHash for ${backfilled} legacy session(s).`);
    } catch (err) {
      console.warn('inputTextHash backfill skipped:', err);
    }
  }

  initHistoryPanel();
  if (loadHistoryOpen()) openHistorySidebar();

  // Global "hide text" switch: load from localStorage, write back on change and
  // cascade to all sentences.
  setGlobalHideText(loadHideText());
  els.globalHideInput.checked = globalHideText;
  els.input.classList.toggle('input-masked', globalHideText);
  els.globalHideInput.addEventListener('change', () => {
    setGlobalHideText(els.globalHideInput.checked);
    saveHideText(globalHideText);
    // Cover the practice textarea with a solid black block in hidden mode.
    els.input.classList.toggle('input-masked', globalHideText);
    for (const s of sentences) applyHidden(s, globalHideText);
    persistSession();
  });

  els.splitBtn.addEventListener('click', handleSplit);
  els.clearInputBtn.addEventListener('click', () => {
    els.input.value = '';
    els.input.focus();
  });

  // Clicking anywhere outside a word closes its open scores panel.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.word')) {
      stopActiveWordRetest();
      document.querySelectorAll('.word.is-open').forEach((el) => el.classList.remove('is-open'));
    }
  });

  render();
}

init();
