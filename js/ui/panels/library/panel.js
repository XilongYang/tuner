// The library sidebar: saved sessions, and the vocabulary collected from them.
//
// Two lists behind one pair of tabs rather than two sidebars, because they
// answer the same question -- what have I done so far -- and because a session
// and the vocabulary taken from it are read together.
//
// The panel holds no data of its own. It asks for a list when it is opened and
// after anything that would change one, and reconciles by id so scroll position
// and the expanded state of a row survive a refresh.

import { el, button, reconcile } from '../../dom.js';
import { confirmModal, promptModal } from '../../modal.js';
import { maskedText } from '../../masked-text.js';
import { panelStatus } from '../../panel-status.js';
import { sessionLabel } from '../../../model/session.js';

const TABS = [
  { name: 'sessions', label: 'Sessions' },
  { name: 'vocab', label: 'Vocabulary' },
];

/**
 * @param {object} spec
 * @param {Element} spec.container
 * @param {object} spec.actions
 * @param {object} spec.player
 * @param {() => boolean} [spec.hideText] Whether practising from memory is on.
 *   The vocabulary list answers to it too: a word list that spells out every
 *   word is the answer key, and hiding the sentences while leaving the words
 *   they were taken from on display hides nothing.
 */
export function createLibraryPanel({ container, actions, player, hideText = () => false }) {
  let tab = 'sessions';
  let openSources = new Set();
  // Words revealed by clicking them while hiding is on. Deliberately not
  // remembered: it is a glance at the answer, and the next time the list is
  // opened the word is hidden again.
  let revealed = new Set();
  // Which session is on screen, so the list can say which one that is. Held
  // here and marked on the rows rather than re-listed from the database: the
  // session changes far more often than the list of them does.
  let currentId = null;

  const tabRow = el('div', { class: 'panel-tabs', role: 'tablist' });
  const list = el('div', { class: 'panel-list' });
  const empty = el('p', { class: 'panel-empty', hidden: true });
  const status = panelStatus();
  const say = status.say;

  const tabButtons = new Map();
  for (const spec of TABS) {
    const btn = button({
      class: 'btn panel-tab',
      text: spec.label,
      role: 'tab',
      onClick: () => { tab = spec.name; refresh(); },
    });
    tabButtons.set(spec.name, btn);
    tabRow.append(btn);
  }

  // No heading of its own: the link that opened this panel is marked as the one
  // that is open, and saying "Library" twice on the same screen only costs the
  // panel a row. The container carries the name for anyone who cannot see that
  // (aria-label, in index.html).
  container.append(tabRow, status.node, empty, list);

  async function refresh() {
    for (const [name, btn] of tabButtons) {
      btn.classList.toggle('is-active', name === tab);
      btn.setAttribute('aria-selected', String(name === tab));
    }
    if (tab === 'sessions') await renderSessions();
    else await renderVocab();
  }

  async function renderSessions() {
    const sessions = await actions.listSessions();
    empty.hidden = sessions.length > 0;
    empty.textContent = 'Nothing saved yet. Split some text to start a session.';

    reconcile(list, sessions, {
      key: (session) => session.id,
      create: (session) => sessionRow(session),
      // A row is cheaper to rebuild than to patch, so it is rebuilt and handed
      // back for reconcile to swap in -- see its note on why a row must not
      // replace itself.
      update: (_element, session) => sessionRow(session),
    });

    markCurrent();
  }

  /** Mark the row of the session that is on screen, if it is in the list. */
  function markCurrent() {
    for (const row of list.querySelectorAll('.library-row[data-session-id]')) {
      const isCurrent = row.dataset.sessionId === currentId;
      row.classList.toggle('is-current', isCurrent);
      // Said in words too: a colour is not available to a screen reader, and
      // "which one am I looking at" is the question this answers.
      row.querySelector('.library-open')?.setAttribute('aria-current', isCurrent ? 'true' : 'false');
    }
  }

  function sessionRow(session) {
    const row = el('div', { class: 'library-row', dataset: { sessionId: session.id } });
    const open = button({
      class: 'btn library-open',
      text: sessionLabel(session),
      title: 'Open this session',
      onClick: () => actions.openSession(session.id),
    });
    const count = el('span', { class: 'library-meta', text: `${(session.sentences || []).length} sentences` });

    const rename = button({
      class: 'btn', text: 'Rename',
      onClick: async () => {
        const name = await promptModal({ title: 'Rename session', label: 'Name', value: session.name ?? '' });
        if (name === null) return;
        await actions.renameSession(session.id, name.trim() || null);
        refresh();
      },
    });

    const remove = button({
      class: 'btn danger', text: 'Delete',
      onClick: async () => {
        const confirmed = await confirmModal({
          title: 'Delete this session?',
          message: `"${sessionLabel(session)}" and its recordings will be deleted here, and on your other devices at the next sync.`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!confirmed) return;
        await actions.deleteSession(session.id);
        say('Session deleted.');
        refresh();
      },
    });

    row.append(open, count, rename, remove);
    return row;
  }

  async function renderVocab() {
    const entries = await actions.listVocab();
    empty.hidden = entries.length > 0;
    empty.textContent = 'No vocabulary yet. Use "Add vocab" on a sentence to collect a word.';

    reconcile(list, entries, {
      key: (entry) => entry.id,
      create: (entry) => vocabRow(entry),
      update: (_element, entry) => vocabRow(entry),
    });
  }

  function vocabRow(entry) {
    const row = el('div', { class: 'library-row vocab-row' });
    const head = el('div', { class: 'vocab-head' });

    const sources = entry.sources || [];
    const playable = sources.filter((source) => source.audio);

    const play = button({
      class: 'btn', text: '▶', title: playable.length ? 'Hear this word' : 'No audio for this word',
      disabled: !playable.length,
      onClick: () => {
        const occurrence = actions.pickOccurrence(entry);
        if (occurrence) player.play(occurrence.audio, `vocab:${entry.id}`);
      },
    });

    const toggle = button({
      class: 'btn',
      text: openSources.has(entry.id) ? 'Hide uses' : `${sources.length} use${sources.length === 1 ? '' : 's'}`,
      onClick: () => {
        if (openSources.has(entry.id)) openSources.delete(entry.id);
        else openSources.add(entry.id);
        refresh();
      },
    });

    const remove = button({
      class: 'btn danger', text: 'Delete',
      onClick: async () => {
        const confirmed = await confirmModal({
          title: 'Delete this word?',
          message: `"${entry.text}" and every use of it will be deleted here, and on your other devices at the next sync.`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!confirmed) return;
        openSources.delete(entry.id);
        await actions.deleteVocab(entry.id);
        say('Word deleted.');
        refresh();
      },
    });

    const hidden = hideText() && !revealed.has(entry.id);
    head.append(
      maskedText(entry.text, {
        class: 'vocab-text',
        hidden,
        onReveal: hidden ? () => { revealed.add(entry.id); refresh(); } : null,
      }),
      play, toggle, remove,
    );
    row.append(head);

    if (openSources.has(entry.id)) {
      const uses = el('div', { class: 'vocab-uses' });
      for (const source of sources) uses.append(vocabUse(entry, source));
      row.append(uses);
    }
    return row;
  }

  function vocabUse(entry, source) {
    const use = el('div', { class: 'vocab-use' });
    // The snapshot, not a lookup: the session this came from may be long gone,
    // and the sentence is what makes the use meaningful.
    const snippet = source.sentenceTextSnapshot;
    if (!snippet) {
      use.append(el('span', { class: 'vocab-snippet', text: '(the original sentence is no longer available)' }));
    } else {
      // A use is revealed with its word: they are the same answer, and a
      // sentence containing the word in plain sight would give it away.
      const hidden = hideText() && !revealed.has(entry.id);
      use.append(maskedText(snippet, {
        class: 'vocab-snippet',
        hidden,
        onReveal: hidden ? () => { revealed.add(entry.id); refresh(); } : null,
      }));
    }

    if (source.sessionId && source.sentenceId) {
      use.append(button({
        class: 'btn', text: '▶', title: 'Hear the whole sentence',
        onClick: async (event) => {
          const btn = event.currentTarget;
          btn.disabled = true;
          try {
            const audio = await actions.sentenceAudioFor(source);
            if (!audio) {
              btn.title = 'That sentence no longer has reference audio.';
              return;
            }
            player.play(audio, `vocab-use:${source.occurrenceId}`);
          } finally {
            btn.disabled = false;
          }
        },
      }));
    }
    return use;
  }

  return {
    setOpen(open) {
      container.hidden = !open;
      container.classList.toggle('is-open', open);
      // Whichever way it went: a line about the last visit's deletion is read
      // as being about this visit.
      status.clear();
      if (open) {
        // A revealed word is a glance at the answer, not a decision about it:
        // opening the list is a fresh look, so it starts covered again.
        revealed = new Set();
        refresh();
      }
    },
    /**
     * Called after a sync, or anything else that may have changed a list.
     *
     * `rehide` is for the one thing that changes what the list shows rather
     * than what is in it: the switch for practising from memory. Turning it
     * back on has to cover the words that were revealed while it was off.
     */
    refreshIfOpen({ rehide = false } = {}) {
      if (rehide) revealed = new Set();
      if (!container.hidden) refresh();
    },

    /**
     * Tell the list which session is on screen. Cheap enough to call on every
     * change: it touches the rows it has, and reads nothing.
     */
    setCurrentSession(id) {
      if (id === currentId) return;
      currentId = id;
      markCurrent();
    },
    say,
  };
}
