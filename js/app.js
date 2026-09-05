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
import {
  els, sentences, globalHideText, setGlobalHideText, persistSession, refreshInputMaskOverlay,
} from './state.js';
import {
  render, handleSplit, handleAudioImport, applyHidden, stopActiveWordRetest,
  clearRowSelection, mergeSelectedSentences,
} from './sentence-panel/index.js';
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
    els.keyStatus.textContent = creds.resourceName
      ? `Key saved · Region = ${creds.region} · Resource = ${creds.resourceName}`
      : `Key saved · Region = ${creds.region}`;
  }
}

function initKeyPanel() {
  els.saveKeyBtn.addEventListener('click', () => {
    const key = els.keyInput.value.trim();
    const region = els.regionInput.value.trim();
    const resourceName = els.resourceNameInput.value.trim();
    if (!key || !region) {
      alert('Please enter both Key and Region');
      return;
    }
    saveCredentials(key, region, resourceName);
    els.keyInput.value = '';
    els.resourceNameInput.value = '';
    updateKeyPanel();
  });

  els.clearKeyBtn.addEventListener('click', () => {
    clearCredentials();
    els.keyInput.value = '';
    els.regionInput.value = '';
    els.resourceNameInput.value = '';
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
  refreshInputMaskOverlay();
  els.input.addEventListener('input', refreshInputMaskOverlay);
  // #input-mask-overlay is a separate element stacked on top of #input-text
  // (see css/input-area.css) -- scrolling the real textarea doesn't move it on its
  // own, so without this the "#" text stays pinned at the top while the
  // (invisible) real text scrolls underneath it. overflow:hidden still
  // allows scrollTop/scrollLeft to be set programmatically.
  els.input.addEventListener('scroll', () => {
    if (!els.inputMaskOverlay) return;
    els.inputMaskOverlay.scrollTop = els.input.scrollTop;
    els.inputMaskOverlay.scrollLeft = els.input.scrollLeft;
  });
  els.globalHideInput.addEventListener('change', () => {
    setGlobalHideText(els.globalHideInput.checked);
    saveHideText(globalHideText);
    // Show "#" over the practice textarea's text (via #input-mask-overlay) in hidden mode.
    els.input.classList.toggle('input-masked', globalHideText);
    for (const s of sentences) applyHidden(s, globalHideText);
    persistSession();
  });

  els.splitBtn.addEventListener('click', handleSplit);
  els.clearInputBtn.addEventListener('click', () => {
    els.input.value = '';
    refreshInputMaskOverlay();
    els.input.focus();
  });

  els.audioImportBtn.addEventListener('click', () => els.audioImportInput.click());
  els.audioImportInput.addEventListener('change', async () => {
    const file = els.audioImportInput.files[0];
    els.audioImportInput.value = ''; // allow re-selecting the same file later
    if (!file) return;
    els.audioImportBtn.disabled = true;
    try {
      await handleAudioImport(file);
    } finally {
      els.audioImportBtn.disabled = false;
    }
  });

  if (els.mergeBtn) els.mergeBtn.addEventListener('click', mergeSelectedSentences);
  if (els.mergeCancelBtn) els.mergeCancelBtn.addEventListener('click', clearRowSelection);

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
