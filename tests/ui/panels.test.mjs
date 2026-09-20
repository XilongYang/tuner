import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;

const { createPanelRegistry } = await import('../../js/ui/panels/registry.js');
const { createLibraryPanel } = await import('../../js/ui/panels/library/panel.js');
const { createSettingsPanel } = await import('../../js/ui/panels/settings/panel.js');
const { createSettings } = await import('../../js/platform/settings.js');
const { DEFAULT_VOICES } = await import('../../js/model/voices.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const clickLabelled = (root, label) => [...root.querySelectorAll('button')].find((b) => b.textContent === label)?.click();
const confirmDialog = (label = 'Delete') => [...document.querySelectorAll('.modal-actions button')].find((b) => b.textContent === label)?.click();

beforeEach(() => document.body.replaceChildren());

// ---- Registry ----

test('registry: opening one panel closes the other, without the panels knowing each other', () => {
  const registry = createPanelRegistry();
  const state = { a: null, b: null };
  registry.register('a', { setOpen: (open) => { state.a = open; } });
  registry.register('b', { setOpen: (open) => { state.b = open; } });

  registry.open('a');
  assert.deepEqual(state, { a: true, b: false });

  registry.open('b');
  assert.deepEqual(state, { a: false, b: true });
});

test('registry: toggle opens and closes the same panel', () => {
  const registry = createPanelRegistry();
  registry.register('a', { setOpen: () => {} });

  registry.toggle('a');
  assert.equal(registry.current(), 'a');
  registry.toggle('a');
  assert.equal(registry.current(), null);
});

test('registry: closing a panel that is not open does not shut whatever is', () => {
  // A close arriving late, after something else opened.
  const registry = createPanelRegistry();
  registry.register('a', { setOpen: () => {} });
  registry.register('b', { setOpen: () => {} });
  registry.open('b');

  assert.equal(registry.close('a'), false);
  assert.equal(registry.current(), 'b');
});

test('registry: a panel registered while another is open starts closed', () => {
  const registry = createPanelRegistry();
  registry.register('a', { setOpen: () => {} });
  registry.open('a');

  let opened = null;
  registry.register('b', { setOpen: (open) => { opened = open; } });
  assert.equal(opened, false);
});

test('registry: opening an unknown panel changes nothing', () => {
  const registry = createPanelRegistry();
  registry.register('a', { setOpen: () => {} });
  registry.open('a');

  assert.equal(registry.open('nope'), false);
  assert.equal(registry.current(), 'a');
});

test('registry: reports which panel is open, for whoever draws the buttons', () => {
  const seen = [];
  const registry = createPanelRegistry({ onChange: (name) => seen.push(name) });
  registry.register('a', { setOpen: () => {} });

  registry.open('a');
  registry.closeAll();
  assert.deepEqual(seen, ['a', null]);
});

// ---- Library panel ----

const session = (id, over = {}) => ({
  id, name: null, folderId: null, splitMode: 'auto', createdAt: 1, updatedAt: 1, metaUpdatedAt: 1,
  inputText: null, inputTextHash: null, sourceAudio: null, sourceAudioHash: null,
  sentences: [{ id: `${id}-s1`, text: `Text of ${id}`, lang: 'en', hidden: false }],
  ...over,
});

const vocabEntry = (id, over = {}) => ({
  id, text: id, lang: 'en', audioPathKey: `k-${id}`, createdAt: 1, updatedAt: 1,
  sources: [{ occurrenceId: `${id}-o1`, sessionId: 'sess1', sentenceId: 's1', sentenceTextSnapshot: `Seen in a sentence about ${id}.`, addedAt: 1, audio: 'CLIP' }],
  ...over,
});

function libraryHarness({ sessions = [session('sess1')], vocab = [vocabEntry('difficult')] } = {}) {
  const dispatched = [];
  const container = document.createElement('div');
  document.body.append(container);

  const panel = createLibraryPanel({
    container,
    player: { play: (audio, token) => dispatched.push(['play', token]) },
    actions: {
      listSessions: async () => sessions,
      listVocab: async () => vocab,
      openSession: (id) => dispatched.push(['openSession', id]),
      renameSession: async (id, name) => dispatched.push(['renameSession', id, name]),
      deleteSession: async (id) => { dispatched.push(['deleteSession', id]); sessions = sessions.filter((s) => s.id !== id); },
      deleteVocab: async (id) => { dispatched.push(['deleteVocab', id]); vocab = vocab.filter((v) => v.id !== id); },
      pickOccurrence: (entry) => entry.sources[0],
      sentenceAudioFor: async (source) => { dispatched.push(['sentenceAudioFor', source.occurrenceId]); return 'SENTENCE_CLIP'; },
    },
  });

  return { container, panel, dispatched };
}

test('library: opening it lists the saved sessions', async () => {
  const h = libraryHarness({ sessions: [session('a'), session('b')] });
  h.panel.setOpen(true);
  await tick();

  assert.equal(h.container.querySelectorAll('.library-row').length, 2);
  assert.equal(h.container.hidden, false);
});

test('library: reopening it lists each session once, not once per visit', async () => {
  // The bug: rows were rebuilt by replacing themselves, which left the old row
  // in place alongside the new one. Every reopen added another copy of every
  // session, and deleting any copy made them all disappear -- one record was
  // behind all of them.
  const h = libraryHarness({ sessions: [session('a'), session('b')] });

  for (let visit = 0; visit < 3; visit++) {
    h.panel.setOpen(true);
    await tick();
    h.panel.setOpen(false);
  }

  h.panel.setOpen(true);
  await tick();
  assert.equal(h.container.querySelectorAll('.library-row').length, 2);
});

test('library: a session opens when its label is clicked', async () => {
  const h = libraryHarness();
  h.panel.setOpen(true);
  await tick();

  h.container.querySelector('.library-open').click();
  assert.deepEqual(h.dispatched, [['openSession', 'sess1']]);
});

test('library: deleting a session asks first, and says what will happen elsewhere', async () => {
  const h = libraryHarness();
  h.panel.setOpen(true);
  await tick();

  clickLabelled(h.container, 'Delete');
  await tick();

  assert.match(document.querySelector('.modal-body').textContent, /at the next sync/);
  confirmDialog('Delete');
  await tick();
  await tick();

  assert.deepEqual(h.dispatched, [['deleteSession', 'sess1']]);
  assert.equal(h.container.querySelectorAll('.library-row').length, 0);
});

test('library: declining the confirmation deletes nothing', async () => {
  const h = libraryHarness();
  h.panel.setOpen(true);
  await tick();

  clickLabelled(h.container, 'Delete');
  await tick();
  confirmDialog('Cancel');
  await tick();

  assert.deepEqual(h.dispatched, []);
  assert.equal(h.container.querySelectorAll('.library-row').length, 1);
});

test('library: the vocabulary tab lists words and plays one', async () => {
  const h = libraryHarness();
  h.panel.setOpen(true);
  await tick();

  clickLabelled(h.container, 'Vocabulary');
  await tick();

  assert.equal(h.container.querySelector('.vocab-text').textContent, 'difficult');
  h.container.querySelector('.vocab-row .btn').click();
  assert.deepEqual(h.dispatched.at(-1), ['play', 'vocab:difficult']);
});

test('library: a word with no audio cannot be played', async () => {
  const h = libraryHarness({ vocab: [vocabEntry('quiet', { sources: [{ occurrenceId: 'o', sentenceTextSnapshot: 'x', addedAt: 1, audio: null }] })] });
  h.panel.setOpen(true);
  await tick();
  clickLabelled(h.container, 'Vocabulary');
  await tick();

  assert.equal(h.container.querySelector('.vocab-row .btn').disabled, true);
});

test('library: uses expand to show the sentence each word came from', async () => {
  const h = libraryHarness();
  h.panel.setOpen(true);
  await tick();
  clickLabelled(h.container, 'Vocabulary');
  await tick();

  clickLabelled(h.container, '1 use');
  await tick();

  assert.match(h.container.querySelector('.vocab-snippet').textContent, /Seen in a sentence about difficult/);
});

test('library: the snapshot is shown even when the original session is gone', async () => {
  const h = libraryHarness({
    vocab: [vocabEntry('orphan', { sources: [{ occurrenceId: 'o', sessionId: null, sentenceId: null, sentenceTextSnapshot: 'The sentence as it read then.', addedAt: 1, audio: null }] })],
  });
  h.panel.setOpen(true);
  await tick();
  clickLabelled(h.container, 'Vocabulary');
  await tick();
  clickLabelled(h.container, '1 use');
  await tick();

  assert.equal(h.container.querySelector('.vocab-snippet').textContent, 'The sentence as it read then.');
  assert.equal(h.container.querySelectorAll('.vocab-use button').length, 0, 'and there is nothing to play');
});

test('library: playing the source sentence asks for it lazily', async () => {
  const h = libraryHarness();
  h.panel.setOpen(true);
  await tick();
  clickLabelled(h.container, 'Vocabulary');
  await tick();
  clickLabelled(h.container, '1 use');
  await tick();

  h.container.querySelector('.vocab-use button').click();
  await tick();

  assert.deepEqual(h.dispatched.at(-2), ['sentenceAudioFor', 'difficult-o1']);
  assert.deepEqual(h.dispatched.at(-1), ['play', 'vocab-use:difficult-o1']);
});

test('library: an empty list explains what to do instead of showing nothing', async () => {
  const h = libraryHarness({ sessions: [] });
  h.panel.setOpen(true);
  await tick();

  assert.equal(h.container.querySelector('.panel-empty').hidden, false);
  assert.match(h.container.querySelector('.panel-empty').textContent, /Split some text/);
});

// ---- Settings panel ----

function settingsHarness({ storage = new Map() } = {}) {
  const dispatched = [];
  const container = document.createElement('div');
  document.body.append(container);

  const settings = createSettings({
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  });

  const panel = createSettingsPanel({
    container,
    settings,
    actions: {
      sync: async () => { dispatched.push(['sync']); return { ok: true, uploaded: 2, downloaded: 1, written: 1, skipped: 0, deleted: 0, swept: 0, warnings: [] }; },
      clearSyncLock: async () => { dispatched.push(['clearSyncLock']); return { ok: true }; },
    },
  });

  return { container, panel, settings, dispatched, storage };
}

const inputLabelled = (container, label) => container.querySelector(`[aria-label="${label}"]`);

test('settings: says when nothing is configured, and what that stops working', () => {
  const h = settingsHarness();
  assert.match(h.container.querySelector('.settings-state').textContent, /Not configured/);
  assert.match(h.container.querySelector('.settings-state').textContent, /Speaking, scoring and audio import/);
});

test('settings: saving credentials stores them and clears the key from the page', () => {
  const h = settingsHarness();
  inputLabelled(h.container, 'Azure subscription key').value = 'super-secret';
  inputLabelled(h.container, 'Azure region').value = 'japaneast';

  clickLabelled(h.container, 'Save');

  assert.deepEqual(h.settings.credentials(), { key: 'super-secret', region: 'japaneast', resourceName: '' });
  assert.equal(inputLabelled(h.container, 'Azure subscription key').value, '', 'the key is not left in the DOM');
  assert.match(h.container.querySelector('.settings-state').textContent, /Configured for japaneast/);
});

test('settings: a stored key is never shown back', () => {
  const h = settingsHarness();
  h.settings.saveCredentials({ key: 'super-secret', region: 'japaneast' });
  h.panel.refresh();

  assert.equal(inputLabelled(h.container, 'Azure subscription key').value, '');
  assert.equal(h.container.textContent.includes('super-secret'), false);
});

test('settings: a key without a region is refused with a reason', () => {
  const h = settingsHarness();
  inputLabelled(h.container, 'Azure subscription key').value = 'k';

  clickLabelled(h.container, 'Save');

  assert.equal(h.settings.credentials(), null);
  assert.match(h.container.querySelector('.panel-status').textContent, /key and a region/);
});

test('settings: a missing resource name is called out as what it costs', () => {
  const h = settingsHarness();
  h.settings.saveCredentials({ key: 'k', region: 'japaneast' });
  h.panel.refresh();
  assert.match(h.container.querySelector('.settings-state').textContent, /audio import is unavailable/);
});

test('settings: sync is unavailable until a container is configured', () => {
  const h = settingsHarness();
  const syncBtn = [...h.container.querySelectorAll('button')].find((b) => b.textContent === 'Sync now');
  assert.equal(syncBtn.disabled, true);

  inputLabelled(h.container, 'Container SAS URL').value = 'https://acct.blob.core.windows.net/tuner?sig=x';
  [...h.container.querySelectorAll('.settings-section')].at(-1).querySelector('.btn.primary').click();

  assert.equal([...h.container.querySelectorAll('button')].find((b) => b.textContent === 'Sync now').disabled, false);
});

test('settings: a completed sync reports what moved', async () => {
  const h = settingsHarness();
  h.settings.saveSasUrl('https://x');
  h.panel.refresh();

  [...h.container.querySelectorAll('button')].find((b) => b.textContent === 'Sync now').click();
  await tick();

  assert.deepEqual(h.dispatched, [['sync']]);
  assert.match(h.container.querySelector('.panel-status').textContent, /2 uploaded, 1 downloaded/);
});

test('settings: clearing the sync lock warns what it is for and asks first', async () => {
  const h = settingsHarness();
  h.settings.saveSasUrl('https://x');
  h.panel.refresh();

  clickLabelled(h.container, 'Clear sync lock');
  await tick();

  assert.match(document.querySelector('.modal-body').textContent, /lets two devices write at once/);
  confirmDialog('Clear it');
  await tick();

  assert.deepEqual(h.dispatched, [['clearSyncLock']]);
});

test('settings: a voice choice is saved as it is changed', () => {
  const h = settingsHarness();
  const select = inputLabelled(h.container, 'Japanese voice');
  select.value = 'ja-JP-KeitaNeural';
  select.dispatchEvent(new dom.window.Event('change'));

  assert.equal(h.settings.voice('ja-JP'), 'ja-JP-KeitaNeural');
});

test('settings: the voice picker opens on the voice actually in use', () => {
  const h = settingsHarness();
  assert.equal(inputLabelled(h.container, 'Japanese voice').value, DEFAULT_VOICES['ja-JP']);
  assert.equal(inputLabelled(h.container, 'English voice').value, DEFAULT_VOICES['en-US']);
});

test('settings: a stored voice outside the offered list is still shown, not silently replaced', () => {
  // Otherwise the picker would show the first option while the app went on
  // speaking with the stored one -- and the next repaint of the panel would
  // make that lie true by saving what is displayed.
  const h = settingsHarness();
  h.settings.saveVoice('ja-JP', 'ja-JP-SomeVoiceNotInTheListNeural');
  h.panel.refresh();

  const select = inputLabelled(h.container, 'Japanese voice');
  assert.equal(select.value, 'ja-JP-SomeVoiceNotInTheListNeural');
  assert.equal(select.selectedOptions[0].textContent, 'ja-JP-SomeVoiceNotInTheListNeural');
});

test('settings: storage that refuses writes is reported rather than failing silently', () => {
  const container = document.createElement('div');
  document.body.append(container);
  createSettingsPanel({
    container,
    settings: createSettings({
      getItem: () => null,
      setItem: () => { throw new DOMException('denied'); },
      removeItem: () => {},
    }),
    actions: { sync: async () => ({ ok: true }), clearSyncLock: async () => ({ ok: true }) },
  });

  inputLabelled(container, 'Azure subscription key').value = 'k';
  inputLabelled(container, 'Azure region').value = 'japaneast';
  clickLabelled(container, 'Save');

  assert.match(container.querySelector('.panel-status').textContent, /refusing to store settings/);
  assert.equal(inputLabelled(container, 'Azure subscription key').value, '',
    'and the key is still cleared from the page, since it was not kept anywhere');
});
