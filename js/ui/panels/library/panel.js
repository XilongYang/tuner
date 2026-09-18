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
 */
export function createLibraryPanel({ container, actions, player }) {
  let tab = 'sessions';
  let openSources = new Set();

  const title = el('h2', { class: 'panel-title', text: 'Library' });
  const tabRow = el('div', { class: 'panel-tabs', role: 'tablist' });
  const list = el('div', { class: 'panel-list' });
  const empty = el('p', { class: 'panel-empty', hidden: true });
  const status = el('p', { class: 'panel-status', hidden: true });

  const say = (message, kind = 'info') => {
    status.hidden = !message;
    status.textContent = message || '';
    status.dataset.kind = kind;
  };

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

  container.append(title, tabRow, status, empty, list);

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
      update: (element, session) => element.replaceWith(sessionRow(session)),
    });
  }

  function sessionRow(session) {
    const row = el('div', { class: 'library-row' });
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
      update: (element, entry) => element.replaceWith(vocabRow(entry)),
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

    head.append(el('span', { class: 'vocab-text', text: entry.text }), play, toggle, remove);
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
    use.append(el('span', {
      class: 'vocab-snippet',
      // The snapshot, not a lookup: the session this came from may be long
      // gone, and the sentence is what makes the use meaningful.
      text: source.sentenceTextSnapshot || '(the original sentence is no longer available)',
    }));

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
      if (open) refresh();
    },
    /** Called after a sync, or anything else that may have changed a list. */
    refreshIfOpen() {
      if (!container.hidden) refresh();
    },
    say,
  };
}
