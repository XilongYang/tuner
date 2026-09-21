// The composition root: the one module that knows every layer, and the only
// place they are joined.
//
// Nothing below this file reaches sideways. A panel is handed the actions it
// may take; a command is handed the capabilities it needs; neither constructs
// the other's dependencies. That is what keeps the dependency direction
// enforceable (tests/arch.test.mjs) rather than aspirational, and what makes
// every layer testable without the ones above it.

import * as db from './db/entities.js';
import { isSupported } from './db/open.js';
import { migrateInlineContent } from './db/migrate.js';
import { container } from './cloud/blob.js';
import { speechClient } from './cloud/speech.js';
import { forceRelease } from './cloud/sync/lock.js';

import { createSettings } from './platform/settings.js';
import { createPlayer } from './platform/player.js';
import { browserSpeech as createBrowserSpeech } from './platform/speech-synthesis.js';
import { createRecorder } from './platform/recorder.js';
import * as hash from './platform/hash.js';
import * as audio from './platform/audio.js';

import { createSessionStore } from './app/store.js';
import { createAutosave } from './app/autosave.js';
import { saveRecord } from './app/persist.js';
import * as session from './app/commands/session.js';
import { isWorthStoring } from './model/session.js';
import * as practice from './app/commands/practice.js';
import * as splitCommands from './app/commands/split.js';
import * as vocab from './app/commands/vocab.js';
import { importAudio } from './app/commands/import-audio.js';
import { syncNow, eraseCloud } from './app/commands/sync.js';

import { createPanelRegistry } from './ui/panels/registry.js';
import { createPracticePanel } from './ui/panels/practice/panel.js';
import { createLibraryPanel } from './ui/panels/library/panel.js';
import { createSettingsPanel } from './ui/panels/settings/panel.js';
import { confirmModal } from './ui/modal.js';
import { el } from './ui/dom.js';

const AUTO_SYNC_DELAY_MS = 3000;

function showFatal(message) {
  document.querySelector('.app-main')?.prepend(el('p', { class: 'app-fatal', text: message }));
}

async function start() {
  if (!isSupported()) {
    showFatal('This browser cannot store anything locally (IndexedDB is unavailable), so Tuner cannot keep your work.');
    return;
  }

  const settings = createSettings();
  const store = createSessionStore();
  const browserSpeech = createBrowserSpeech(window);
  // The player enforces one sound at a time, and is told how to silence the
  // other source of it; see its own note.
  const player = createPlayer({ silenceOthers: () => browserSpeech.cancel() });

  const statusLine = document.getElementById('app-status');
  const say = (message, kind = 'info') => {
    statusLine.hidden = !message;
    statusLine.textContent = message || '';
    statusLine.dataset.kind = kind;
  };

  // Built per call rather than once: both depend on settings the user can
  // change at any moment, and a client built at startup would keep using
  // credentials that have since been replaced.
  const speech = () => speechClient(settings.credentials());
  const containerOrNull = () => {
    const url = settings.sasUrl();
    return url ? container(url) : null;
  };

  const autosave = createAutosave({
    store,
    db,
    hash,
    saveRecord,
    onError: (err) => say(`Could not save: ${err.message}`, 'error'),
  });

  // The manifest's ETag, kept between rounds so an unchanged manifest is not
  // re-downloaded and re-parsed every time.
  let manifestCache = { etag: null, manifest: null };
  const manifestCacheApi = { get: () => manifestCache, set: (next) => { manifestCache = next; } };

  const ids = () => crypto.randomUUID();
  const clock = () => Date.now();

  // `release` is how a command discards whatever the screen was holding without
  // knowing what that is. The practice panel fills it in once it exists.
  let releaseWorkspace = () => {};

  const commandDeps = {
    db, hash, audio, settings, speech, player, browserSpeech, ids, clock, saveRecord, autosave,
    release: () => releaseWorkspace(),
    // A split or a merge replaces sentences, which leaves their clips with
    // nothing pointing at them. Collected here rather than only at the end of a
    // sync round: someone with no container configured never has a round, and
    // the bytes would sit in their quota for good.
    //
    // The flush is what lets the sweep see them at all. Saving is debounced, so
    // at this moment the stored session still lists the sentences that were
    // just replaced -- and content a stored record still references is content
    // the sweep must leave alone.
    tombstone: async (sentenceIds) => {
      await db.tombstoneSentences(sentenceIds);
      await autosave.flush();
      await db.sweepContent();
    },
  };

  const runSync = async (onProgress) => {
    const result = await syncNow({
      deps: {
        container: containerOrNull(), db, settings, hash,
        manifestCache: manifestCacheApi,
        onProgress,
      },
    });
    if (result.ok) {
      // A round may have replaced the session on screen; put the stored copy
      // back so the user sees what was merged.
      const current = store.get();
      if (current) {
        const stored = await db.getOne('sessions', current.id);
        if (stored) session.applyIncoming({ store, session: stored, deps: commandDeps });
      }
      library.refreshIfOpen();
    }
    return result;
  };

  // Auto-sync: edits settle, then one round. Coalesced the same way saving is,
  // for the same reason -- a burst of changes is one thing to publish, not
  // twenty. Failures are silent here because the user did not ask for this
  // round; the Sync button reports properly.
  let syncHandle = null;
  const scheduleSync = () => {
    if (!containerOrNull()) return;
    clearTimeout(syncHandle);
    syncHandle = setTimeout(async () => {
      await autosave.flush();
      const result = await runSync();
      if (!result.ok && !String(result.reason).startsWith('locked')) {
        console.warn('Background sync did not complete:', result.reason);
      }
    }, AUTO_SYNC_DELAY_MS);
  };
  store.subscribe((_session, { reason }) => {
    if (reason !== 'saved' && reason !== 'incoming') scheduleSync();
  });

  // Remember what is on screen, so a refresh comes back to it rather than to a
  // blank page. Opening a session records this too, but a session the user just
  // created by splitting text has never been opened -- and that is precisely
  // the one they are in the middle of.
  //
  // Only one that is being stored: an id that was never written is an id the
  // next startup would look for, fail to find, and have to recover from.
  store.subscribe((current) => settings.saveLastSessionId(isWorthStoring(current) ? current.id : null));

  // ---- Panels ----

  const registry = createPanelRegistry({
    onChange: (open) => {
      document.getElementById('toggle-library').setAttribute('aria-expanded', String(open === 'library'));
      document.getElementById('toggle-settings').setAttribute('aria-expanded', String(open === 'settings'));
    },
  });

  const practicePanel = createPracticePanel({
    container: document.getElementById('practice'),
    store,
    player,
    createRecorder,
    actions: {
      splitText: (text) => session.splitTypedText({ store, text, deps: commandDeps }),
      startNew: () => session.startNew({ store, deps: commandDeps }),
      split: (sentenceId, charIndex, ms) => splitCommands.splitAtPointer({ store, sentenceId, charIndex, ms, deps: commandDeps }),
      merge: (sentenceIds) => splitCommands.mergeSelected({ store, sentenceIds, deps: commandDeps }),
      speak: (sentenceId) => practice.speak({ store, sentenceId, deps: commandDeps }),
      score: (sentenceId) => practice.score({ store, sentenceId, deps: commandDeps }),
      startRecording: (sentenceId, recorder) => practice.startRecording({ store, sentenceId, recorder, deps: commandDeps }),
      stopRecording: (sentenceId, recorder) => practice.stopRecording({ store, sentenceId, recorder, deps: commandDeps }),
      toggleHidden: (sentenceId, hidden) => practice.toggleHidden({ store, sentenceId, hidden, deps: commandDeps }),
      setLanguage: (sentenceId, lang) => practice.setLanguage({ store, sentenceId, lang, deps: commandDeps }),
      addVocab: async (sentenceId) => {
        const current = store.get();
        const sentence = (current?.sentences || []).find((s) => s.id === sentenceId);
        // Every word of the sentence for now; a picker for choosing part of it
        // is the next thing this hook will call.
        const outcome = await vocab.addOccurrence({ store, sentenceId, words: sentence?.words ?? [], deps: commandDeps });
        if (outcome.ok) library.refreshIfOpen();
        return outcome;
      },
      importAudio: (file, onProgress) => importAudio({ store, file, deps: commandDeps, onProgress }),
    },
  });
  releaseWorkspace = () => {
    // Leaving a session stops what it was saying, the browser's own voice
    // included -- it is not a clip the player holds, so it would otherwise keep
    // reading a sentence that is no longer on screen.
    browserSpeech.cancel();
    practicePanel.release();
  };

  const library = createLibraryPanel({
    container: document.getElementById('library'),
    player,
    actions: {
      listSessions: async () => (await db.listAll('sessions')).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
      listVocab: () => vocab.list({ deps: commandDeps }),
      // The library stays open: picking a session is often one of several --
      // comparing, or working through a few -- and closing it would make the
      // next one a fresh hunt. The list says which one is on screen instead.
      openSession: async (id) => {
        await autosave.flush();
        await session.open({ store, sessionId: id, deps: commandDeps });
      },
      renameSession: async (id, name) => {
        const stored = await db.getOne('sessions', id);
        if (!stored) return;
        await db.put('sessions', { ...stored, name, updatedAt: clock(), metaUpdatedAt: clock() });
        if (store.get()?.id === id) session.describe({ store, patch: { name }, deps: commandDeps });
      },
      deleteSession: (id) => session.remove({ store, sessionId: id, deps: commandDeps }),
      deleteVocab: (id) => vocab.removeEntry({ id, deps: commandDeps }),
      pickOccurrence: (entry) => vocab.pickOccurrenceAudio(entry),
      sentenceAudioFor: (source) => vocab.sourceSentenceAudio({ occurrence: source, deps: commandDeps }),
    },
  });

  const settingsPanel = createSettingsPanel({
    container: document.getElementById('settings'),
    settings,
    actions: {
      sync: (onProgress) => runSync(onProgress),
      eraseCloud: async (onProgress) => {
        const outcome = await eraseCloud({
          deps: { container: containerOrNull(), settings, manifestCache: manifestCacheApi, onProgress },
        });
        library.refreshIfOpen();
        return outcome;
      },
      clearSyncLock: async () => {
        const target = containerOrNull();
        if (!target) return { ok: false, reason: 'no container configured' };
        if (!await confirmModal({ title: 'Really clear it?', message: 'Only do this if no other device is syncing right now.', confirmLabel: 'Clear', danger: true })) {
          return { ok: false, reason: 'cancelled' };
        }
        try {
          await forceRelease(target);
          return { ok: true };
        } catch (err) {
          return { ok: false, reason: err.message };
        }
      },
    },
  });

  registry.register('library', library);
  registry.register('settings', settingsPanel);

  // The library marks whichever session is on screen, so it stays truthful when
  // one is opened from it, replaced by New session, or brought in by a sync.
  store.subscribe((current) => library.setCurrentSession(current?.id ?? null));
  library.setCurrentSession(store.get()?.id ?? null);

  document.getElementById('toggle-library').addEventListener('click', () => registry.toggle('library'));
  document.getElementById('toggle-settings').addEventListener('click', () => registry.toggle('settings'));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !document.querySelector('.modal-backdrop')) registry.closeAll();
  });

  // Anything not yet written is written before the page goes away. Both events
  // are used because neither is reliable alone: pagehide does not fire when a
  // tab is discarded, and visibilitychange fires for a switch that is not a
  // close. Neither can be awaited, which is why saving is debounced in
  // hundreds of milliseconds rather than relying on this at all.
  window.addEventListener('pagehide', () => { autosave.flush(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosave.flush();
  });

  // Before any record is read as a whole: a session stored by version 1 keeps
  // its audio inside itself, and a reader now expects the bytes to be in the
  // content store. This moves them, once; afterwards it finds nothing to do.
  try {
    const migration = await migrateInlineContent({ hash });
    const lost = migration.unreadable.length;
    if (lost) {
      say(`${lost} stored clip${lost === 1 ? '' : 's'} could not be read, so ${lost === 1 ? 'its sentence still claims it' : 'their sentences still claim them'}; a sync brings ${lost === 1 ? 'it' : 'them'} back if the cloud copy has ${lost === 1 ? 'it' : 'them'}.`, 'error');
    }
  } catch (err) {
    say(`Moving stored audio into its own store did not finish: ${err.message}`, 'error');
  }

  await session.reopenLast({ store, deps: commandDeps });

  // One round at startup, so a session recorded on another device is here
  // before the user starts looking for it.
  if (containerOrNull()) {
    const result = await runSync();
    if (!result.ok && !String(result.reason).startsWith('locked')) {
      say(`Sync at startup did not complete: ${result.reason}`, 'error');
    }
  }

  // ---- Practising from memory, for every sentence at once ----
  //
  // A mode rather than an action, so it is a switch in the header: the
  // per-sentence chips are for the odd exception. The switch holds across
  // sessions and across reloads, and newly split or imported sentences start
  // the way it is set -- otherwise it would be undone by the next Split.
  const hideAll = document.getElementById('hide-all');
  hideAll.checked = settings.hideText();
  hideAll.addEventListener('change', () => {
    practice.setAllHidden({ store, hidden: hideAll.checked, deps: commandDeps });
  });
  // A session arriving from storage or a sync decides how the switch reads: it
  // shows the state of what is on screen, and only a session hidden right
  // through counts as hidden.
  store.subscribe((current) => {
    const sentences = current?.sentences ?? [];
    if (sentences.length) hideAll.checked = sentences.every((sentence) => sentence.hidden);
  });

  // Exposed for the end-to-end tests, which drive the app the way a person
  // does and need to seed and inspect stored data to do it.
  window.tuner = { store, db, settings, registry, commandDeps, runSync, autosave, practicePanel };
}

start().catch((err) => {
  console.error(err);
  showFatal(`Tuner could not start: ${err.message}`);
});
