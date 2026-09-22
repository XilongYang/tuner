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
import { migrateInlineContent, assignSortKeys } from './db/migrate.js';
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
import * as order from './app/commands/order.js';
import { serialize } from './app/serialize.js';
import { importAudio } from './app/commands/import-audio.js';
import { syncNow, eraseCloud } from './app/commands/sync.js';

import { createSidebar } from './ui/panels/sidebar.js';
import { createSyncIndicator } from './ui/sync-indicator.js';
import { describeSync, syncProgress, syncState } from './ui/sync-text.js';
import { createPracticePanel } from './ui/panels/practice/panel.js';
import { vocabPicker } from './ui/panels/practice/vocab-picker.js';
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
    // A session joins the library the first time it is worth storing, and it
    // joins it at the top. Nothing moves it afterwards but the user.
    prepare: (record) => order.placeNew({ db, record }),
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

  // Every round goes through here -- startup, an edit settling, the button --
  // so this is the one place that knows when one is running, and therefore the
  // only place the header's indicator is driven from.
  const syncIndicator = createSyncIndicator(document.getElementById('sync-indicator'));

  const runRound = async (onProgress) => {
    syncIndicator.set({ state: 'syncing', detail: syncProgress(null) });
    const result = await syncNow({
      deps: {
        container: containerOrNull(), db, settings, hash,
        manifestCache: manifestCacheApi,
        onProgress: (progress) => {
          syncIndicator.set({ state: 'syncing', detail: syncProgress(progress) });
          onProgress?.(progress);
        },
      },
    });
    syncIndicator.set({ state: syncState(result), detail: describeSync(result), at: clock() });
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

  // One round at a time in this tab, and at most one waiting behind it.
  //
  // The container lock stops two *devices* running a round at once; it says
  // nothing about two rounds in one tab (see cloud/sync/lock.js, which says so
  // and leaves it to whatever schedules rounds -- this). A second round started
  // here would be refused by this device's own lock and reported as "another
  // device is syncing", which is a lie told to the person who just pressed
  // Sync now while the automatic round was running.
  const runSync = serialize(runRound);

  /**
   * A container has just been set or forgotten in Settings.
   *
   * Setting one starts a round straight away rather than waiting for the next
   * edit: what is already up there is what the user wants to see, and a dot
   * reading "Syncing" with nothing running would be a lie.
   */
  const containerChanged = () => {
    if (!containerOrNull()) {
      syncIndicator.set({ state: 'off' });
      return;
    }
    runSync();
  };

  // Auto-sync: edits settle, then one round. Coalesced the same way saving is,
  // for the same reason -- a burst of changes is one thing to publish, not
  // twenty. Nothing is announced: the round is not something the user asked
  // for, and the header's indicator is where its outcome belongs.
  let syncHandle = null;
  const scheduleSync = () => {
    if (!containerOrNull()) return;
    clearTimeout(syncHandle);
    syncHandle = setTimeout(async () => {
      await autosave.flush();
      // Nothing is reported here on purpose: the indicator already shows what
      // this round did, and the user did not ask for it.
      await runSync();
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

  const practicePanel = createPracticePanel({
    container: document.getElementById('practice'),
    store,
    player,
    createRecorder,
    actions: {
      splitText: (text) => session.splitTypedText({ store, text, deps: commandDeps }),
      startNew: () => session.startNew({ store, deps: commandDeps }),
      // The per-word parts of a score. None of them writes anything: a word
      // played, re-said or re-scored on its own is practice, and the stored
      // score describes one reading of the whole sentence.
      wordClip: (sentenceId, word) => practice.wordClip({ store, sentenceId, word, deps: commandDeps }),
      scoreWord: (text, lang, blob) => practice.scoreWord({ text, lang, blob, deps: commandDeps }),
      speakWord: (text, lang) => practice.speakWord({ text, lang, deps: commandDeps }),
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
        if (!sentence) return { ok: false, reason: 'gone' };

        // The picker decides what is recorded and keeps its own count across
        // retries; this only supplies the writing.
        const picked = await vocabPicker({
          sentence,
          addGroups: (groups) => vocab.addOccurrences({ store, sentenceId, groups, deps: commandDeps }),
        });
        if (!picked) return { ok: true, cancelled: true };
        library.refreshIfOpen();
        return { ok: true, added: picked.added };
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
      // In the order the user arranged, and in no other: see model/order.js.
      listSessions: () => order.listOrdered({ db }),
      moveSession: (move) => order.moveSession({ db, clock, store, ...move }),
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
      setVocabHidden: (id, hidden) => vocab.setHidden({ id, hidden, deps: commandDeps }),
      pickOccurrence: (entry) => vocab.pickOccurrenceAudio(entry),
      sentenceAudioFor: (source) => vocab.sourceSentenceAudio({ occurrence: source, deps: commandDeps }),
    },
  });

  const settingsPanel = createSettingsPanel({
    container: document.getElementById('settings'),
    settings,
    // There is nothing to say about syncing until there is somewhere to sync
    // to, and nothing to say once that is forgotten.
    onContainerChange: containerChanged,
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

  // One sidebar, three views. The header keeps one button for it; which list
  // is showing is chosen in the panel itself.
  const sidebarToggle = document.getElementById('toggle-sidebar');
  const sidebar = createSidebar({
    container: document.getElementById('sidebar'),
    tabs: document.getElementById('sidebar-tabs'),
    views: [
      { name: 'sessions', label: 'Sessions', panel: library, tab: 'sessions' },
      { name: 'vocab', label: 'Vocabulary', panel: library, tab: 'vocab' },
      { name: 'settings', label: 'Settings', panel: settingsPanel },
    ],
    onChange: (open) => sidebarToggle.setAttribute('aria-expanded', String(open !== null)),
  });
  // Which view the button opens on: the one it was left on, so a person who
  // lives in the vocabulary list does not land in the sessions list every time.
  let lastView = 'sessions';

  // The library marks whichever session is on screen, so it stays truthful when
  // one is opened from it, replaced by New session, or brought in by a sync.
  store.subscribe((current) => library.setCurrentSession(current?.id ?? null));
  library.setCurrentSession(store.get()?.id ?? null);

  sidebarToggle.addEventListener('click', () => {
    if (sidebar.current() !== null) {
      lastView = sidebar.current();
      sidebar.close();
    } else {
      sidebar.open(lastView);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || document.querySelector('.modal-backdrop')) return;
    if (sidebar.current() !== null) lastView = sidebar.current();
    sidebar.close();
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
    // Sessions stored before the list had an arrangement get one here, in the
    // order they were last shown in, so the first look after this is not a
    // reshuffle.
    await assignSortKeys();
    const lost = migration.unreadable.length;
    if (lost) {
      say(`${lost} stored clip${lost === 1 ? '' : 's'} could not be read, so ${lost === 1 ? 'its sentence still claims it' : 'their sentences still claim them'}; a sync brings ${lost === 1 ? 'it' : 'them'} back if the cloud copy has ${lost === 1 ? 'it' : 'them'}.`, 'error');
    }
  } catch (err) {
    say(`Moving stored audio into its own store did not finish: ${err.message}`, 'error');
  }

  await session.reopenLast({ store, deps: commandDeps });

  // One round at startup, so a session recorded on another device is here
  // before the user starts looking for it. Its outcome is not announced: the
  // header's indicator is where sync state lives now, and a floating message
  // saying the same thing is one the user has to dismiss to read the page.
  syncIndicator.set(containerOrNull() ? { state: 'syncing', detail: 'Starting sync…' } : { state: 'off' });
  if (containerOrNull()) await runSync();

  // ---- Practising from memory, for every sentence at once ----
  //
  // A mode rather than an action, so it is a switch in the header: the
  // per-sentence chips are for the odd exception. The switch holds across
  // sessions and across reloads, and newly split or imported sentences start
  // the way it is set -- otherwise it would be undone by the next Split.
  const hideAll = document.getElementById('hide-all');
  hideAll.checked = settings.hideText();
  hideAll.addEventListener('change', async () => {
    practice.setAllHidden({ store, hidden: hideAll.checked, deps: commandDeps });
    // The vocabulary list carries the same fact per entry, and is not driven by
    // the session store, so it is set here and told to repaint -- and a word
    // peeked at while hiding was off has to go back under cover.
    await vocab.setAllHidden({ hidden: hideAll.checked, deps: commandDeps });
    library.refreshIfOpen({ rehide: true });
  });
  // A session arriving from storage or a sync decides how the switch reads: it
  // shows the state of what is on screen, and only a session hidden right
  // through counts as hidden.
  //
  // What it reads is also what it means, so the stored preference moves with
  // it. Otherwise the switch says "on" while `startsHidden` still reads the
  // old value, and the next sentence split -- or the next word collected --
  // arrives uncovered, in plain sight, next to a page of covered ones.
  store.subscribe((current) => {
    const sentences = current?.sentences ?? [];
    if (!sentences.length) return;
    const allHidden = sentences.every((sentence) => sentence.hidden);
    hideAll.checked = allHidden;
    if (allHidden !== settings.hideText()) settings.saveHideText(allHidden);
  });

  // Exposed for the end-to-end tests, which drive the app the way a person
  // does and need to seed and inspect stored data to do it.
  window.tuner = { store, db, settings, sidebar, commandDeps, runSync, autosave, practicePanel };
}

start().catch((err) => {
  console.error(err);
  showFatal(`Tuner could not start: ${err.message}`);
});
