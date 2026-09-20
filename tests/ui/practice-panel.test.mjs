// The practice panel driven through its DOM: clicking the controls a user
// clicks, and checking what the panel dispatched and what survived a repaint.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;

const { createPracticePanel } = await import('../../js/ui/panels/practice/panel.js');
const { renderSentenceText, markersOf } = await import('../../js/ui/panels/practice/sentence-text.js');
const { createSessionStore } = await import('../../js/app/store.js');
const { blankSentence, updateSentence } = await import('../../js/model/session.js');

const sentence = (id, text, over = {}) => blankSentence({ id, text, lang: 'en', now: 1, ...over });
const session = (sentences, over = {}) => ({
  id: 'sess1', name: null, folderId: null, splitMode: 'auto',
  createdAt: 1, updatedAt: 1, metaUpdatedAt: 1,
  inputText: 'typed text', inputTextHash: null, sourceAudio: null, sourceAudioHash: null,
  sentences, ...over,
});

const word = (charStart, charEnd, offsetMs, durationMs) => ({ charStart, charEnd, offsetMs, durationMs });

function fakeRecorder() {
  let recording = false;
  return {
    get isRecording() { return recording; },
    start: async () => { recording = true; return true; },
    stop: async () => { recording = false; return { blob: new Blob(), durationMs: 100 }; },
    dispose() { recording = false; this.disposed = true; },
    disposed: false,
  };
}

function harness(initial = session([sentence('s1', 'Alpha beta')]), actionOverrides = {}) {
  const dispatched = [];
  const recorders = [];
  const store = createSessionStore(initial);
  const container = document.createElement('div');
  document.body.replaceChildren(container);

  const actions = {
    splitText: (text) => { dispatched.push(['splitText', text]); return { ok: Boolean(text.trim()) }; },
    startNew: () => dispatched.push(['startNew']),
    split: async (id, charIndex, ms) => { dispatched.push(['split', id, charIndex, ms]); return { ok: true, audioFollowed: null }; },
    speak: async (id) => { dispatched.push(['speak', id]); return { ok: true, synthesized: true }; },
    score: async (id) => { dispatched.push(['score', id]); return { ok: true }; },
    startRecording: async (id, recorder) => { dispatched.push(['startRecording', id]); await recorder.start(); return { ok: true }; },
    stopRecording: async (id, recorder) => { dispatched.push(['stopRecording', id]); await recorder.stop(); return { ok: true }; },
    toggleHidden: (id, hidden) => { dispatched.push(['toggleHidden', id, hidden]); store.apply((s) => updateSentence(s, id, { hidden }, 2)); },
    setLanguage: (id, lang) => { dispatched.push(['setLanguage', id, lang]); store.apply((s) => updateSentence(s, id, { lang }, 2)); },
    addVocab: async (id) => { dispatched.push(['addVocab', id]); return { ok: true }; },
    merge: async (ids) => { dispatched.push(['merge', ids]); return { ok: true, audioFollowed: null }; },
    importAudio: async (file, onProgress) => { dispatched.push(['importAudio', file.name]); onProgress({ stage: 'transcribing' }); return { ok: true, count: 2, withAudio: 2 }; },
    ...actionOverrides,
  };

  const panel = createPracticePanel({
    container,
    store,
    actions,
    player: { play: async (...args) => dispatched.push(['play', args[1]]), stop: () => {} },
    createRecorder: () => { const r = fakeRecorder(); recorders.push(r); return r; },
  });

  return { store, container, dispatched, panel, recorders };
}

const rowsOf = (container) => [...container.querySelectorAll('.sentence-row')];
const buttonIn = (row, label) => [...row.querySelectorAll('button')].find((b) => b.textContent === label);

beforeEach(() => { document.body.replaceChildren(); });

test('renders one row per sentence', () => {
  const h = harness(session([sentence('s1', 'One.'), sentence('s2', 'Two.')]));
  assert.equal(rowsOf(h.container).length, 2);
  assert.match(h.container.querySelector('.practice-count').textContent, /2 sentences/);
});

test('the text box shows the session text and Split starts a new session once split', () => {
  const h = harness();
  assert.equal(h.container.querySelector('.practice-input').value, 'typed text');
  assert.equal(h.container.querySelector('.practice-input').readOnly, true, 'a split session is not edited by typing');

  buttonIn(h.container, 'New session').click();
  assert.deepEqual(h.dispatched, [['startNew']]);
});

test('with nothing split yet, Split dispatches the typed text', () => {
  const h = harness(session([]));
  const input = h.container.querySelector('.practice-input');
  input.value = 'One. Two.';

  buttonIn(h.container, 'Split').click();
  assert.deepEqual(h.dispatched, [['splitText', 'One. Two.']]);
});

test('a cut marker passes its timestamp through, and null stays null', async () => {
  // The boundary rule: an empty attribute must not arrive as 0.
  const h = harness(session([sentence('s1', 'Alpha beta', { words: [word(0, 5, 1000, 400), word(6, 10, 1500, 400)] })]));
  const marker = h.container.querySelector('.split-marker');

  marker.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(h.dispatched.at(-1), ['split', 's1', 6, 1500]);
});

test('a cut marker with no timing passes null, not zero', async () => {
  const h = harness(session([sentence('s1', 'あいう')]));
  h.container.querySelector('.split-marker').click();
  await new Promise((r) => setTimeout(r, 0));

  const [, , , ms] = h.dispatched.at(-1);
  assert.equal(ms, null);
});

test('a split that could not keep its audio says so', async () => {
  const h = harness(undefined, { split: async () => ({ ok: true, audioFollowed: false }) });

  h.container.querySelector('.split-marker').click();
  await new Promise((r) => setTimeout(r, 0));

  assert.match(h.container.querySelector('.sentence-status').textContent, /no audio timing at that position/);
});

test('a failed action explains itself rather than showing a bare code', async () => {
  const h = harness(undefined, { speak: async () => ({ ok: false, reason: 'no-credentials' }) });

  buttonIn(rowsOf(h.container)[0], 'Speak').click();
  await new Promise((r) => setTimeout(r, 0));

  assert.match(h.container.querySelector('.sentence-status').textContent, /Azure key and region/);
});

test('every control is usable again after an action fails', async () => {
  // Disabling on entry and re-enabling only on success is how a control ends
  // up permanently dead.
  const h = harness(undefined, { speak: async () => { throw new Error('network down'); } });
  const [row] = rowsOf(h.container);

  buttonIn(row, 'Speak').click();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(buttonIn(row, 'Speak').disabled, false);
  assert.match(h.container.querySelector('.sentence-status').textContent, /network down/);
});

test('Speak, Score and Add vocab dispatch for their own sentence', async () => {
  const h = harness(session([
    sentence('s1', 'One.', { recording: new Blob(), words: [word(0, 3, 0, 100)] }),
    sentence('s2', 'Two.'),
  ]));
  const [first] = rowsOf(h.container);

  buttonIn(first, 'Speak').click();
  await new Promise((r) => setTimeout(r, 0));
  buttonIn(first, 'Score').click();
  await new Promise((r) => setTimeout(r, 0));
  buttonIn(first, 'Add vocab').click();
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(h.dispatched, [['speak', 's1'], ['score', 's1'], ['addVocab', 's1']]);
});

test('Score and Playback appear only once there is a take', () => {
  const h = harness(session([sentence('s1', 'One.')]));
  const [row] = rowsOf(h.container);
  assert.equal(buttonIn(row, 'Score').hidden, true);
  assert.equal(buttonIn(row, 'Playback').hidden, true);

  h.store.apply((s) => updateSentence(s, 's1', { recording: new Blob() }, 5));
  assert.equal(buttonIn(rowsOf(h.container)[0], 'Score').hidden, false);
});

test('Add vocab appears only when the sentence has word positions to pick from', () => {
  const h = harness(session([sentence('s1', 'One.')]));
  assert.equal(buttonIn(rowsOf(h.container)[0], 'Add vocab').hidden, true);

  h.store.apply((s) => updateSentence(s, 's1', { words: [word(0, 3, 0, 100)] }, 5));
  assert.equal(buttonIn(rowsOf(h.container)[0], 'Add vocab').hidden, false);
});

test('Record toggles to Stop, and stays live while recording so it can be stopped', async () => {
  const h = harness();
  const [row] = rowsOf(h.container);

  buttonIn(row, 'Record').click();
  await new Promise((r) => setTimeout(r, 0));

  const stop = buttonIn(row, 'Stop');
  assert.ok(stop, 'the control became Stop');
  assert.equal(stop.disabled, false);
  assert.ok(row.classList.contains('is-recording'));

  stop.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(h.dispatched, [['startRecording', 's1'], ['stopRecording', 's1']]);
});

test('a sync repaint mid-recording does not interrupt it', () => {
  // The property keyed reconciliation exists for: the row, and the recorder
  // living in it, survive a repaint caused by something else.
  const h = harness();
  const [before] = rowsOf(h.container);
  h.recorders[0] ?? buttonIn(before, 'Record').click();

  h.store.apply((s) => updateSentence(s, 's1', { hidden: true }, 9), 'sync');

  const [after] = rowsOf(h.container);
  assert.equal(after, before, 'the row element was updated, not replaced');
  assert.equal(h.recorders.filter((r) => r.disposed).length, 0, 'and no recorder was disposed');
});

test('hiding a sentence masks the text and withdraws its cut markers', () => {
  const h = harness();
  assert.ok(h.container.querySelector('.split-marker'), 'markers before');

  buttonIn(rowsOf(h.container)[0], 'Hide text').click();

  const row = rowsOf(h.container)[0];
  assert.equal(row.querySelector('.split-marker'), null, 'nothing to aim at when the text is masked');
  assert.ok(row.querySelector('.sentence-mask'));
  assert.equal(buttonIn(row, 'Show text').textContent, 'Show text');
});

test('the language control shows and switches the sentence language', () => {
  const h = harness();
  const [row] = rowsOf(h.container);
  assert.equal(buttonIn(row, 'English').textContent, 'English');

  buttonIn(row, 'English').click();
  assert.deepEqual(h.dispatched, [['setLanguage', 's1', 'ja']]);
  assert.ok(buttonIn(rowsOf(h.container)[0], '日本語'));
});

test('a score is shown once there is one', () => {
  const h = harness();
  assert.equal(h.container.querySelector('.sentence-score').hidden, true);

  h.store.apply((s) => updateSentence(s, 's1', {
    assessment: { overall: { pronunciation: 87.4, accuracy: 90, fluency: 80 } },
  }, 5));

  const line = h.container.querySelector('.sentence-score');
  assert.equal(line.hidden, false);
  assert.match(line.textContent, /Pronunciation 87 · accuracy 90 · fluency 80/);
});

test('rows are added and removed as the session changes, in order', () => {
  const h = harness(session([sentence('s1', 'One.'), sentence('s2', 'Two.')]));
  h.store.replace(session([sentence('s1', 'One.'), sentence('new', 'Inserted.'), sentence('s2', 'Two.')]));

  assert.deepEqual(rowsOf(h.container).map((r) => r.querySelector('.sentence-text').textContent),
    ['One.', 'Inserted.', 'Two.']);
});

test('a sentence that goes away takes its recorder with it', () => {
  const h = harness(session([sentence('s1', 'One.'), sentence('s2', 'Two.')]));
  buttonIn(rowsOf(h.container)[1], 'Record').click();
  const recorder = h.recorders.at(-1);

  h.store.replace(session([sentence('s1', 'One.')]));

  assert.equal(recorder.disposed, true);
  assert.equal(rowsOf(h.container).length, 1);
});

test('release disposes every recorder the panel holds', () => {
  const h = harness(session([sentence('s1', 'One.'), sentence('s2', 'Two.')]));
  buttonIn(rowsOf(h.container)[0], 'Record').click();
  buttonIn(rowsOf(h.container)[1], 'Record').click();

  h.panel.release();
  assert.equal(h.recorders.filter((r) => r.disposed).length, h.recorders.length);
});

test('importing reports progress and then the outcome', async () => {
  const h = harness(session([]));
  const fileInput = h.container.querySelector('.practice-file');
  Object.defineProperty(fileInput, 'files', { value: [new File([new Uint8Array([1])], 'lesson.mp3')], configurable: true });

  fileInput.dispatchEvent(new dom.window.Event('change'));
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(h.dispatched, [['importAudio', 'lesson.mp3']]);
  assert.match(h.container.querySelector('.practice-status').textContent, /Imported 2 sentences/);
});

test('renderSentenceText: offers a marker at every interior position of unspaced text', () => {
  const element = renderSentenceText(sentence('s1', 'あいう'), { onSplit: () => {} });
  assert.deepEqual(markersOf(element), [{ charIndex: 1, ms: null }, { charIndex: 2, ms: null }]);
});

test('renderSentenceText: English offers a marker per word start, not per letter', () => {
  const element = renderSentenceText(sentence('s1', 'Alpha beta gamma.'), { onSplit: () => {} });
  assert.deepEqual(markersOf(element), [{ charIndex: 6, ms: null }, { charIndex: 11, ms: null }]);
});

test('renderSentenceText: a real word boundary carries its timestamp, including 0', () => {
  const element = renderSentenceText(sentence('s1', 'ab cd', { words: [word(0, 2, 0, 100), word(3, 5, 0, 100)] }), { onSplit: () => {} });
  assert.deepEqual(markersOf(element), [{ charIndex: 3, ms: 0 }]);
});

test('renderSentenceText: the text reads back exactly, markers aside', () => {
  const element = renderSentenceText(sentence('s1', 'Alpha beta'), { onSplit: () => {} });
  const chunks = [...element.querySelectorAll('.sentence-chunk')].map((c) => c.textContent).join('');
  assert.equal(chunks, 'Alpha beta');
});

test('renderSentenceText: a masked sentence shows its length and nothing else', () => {
  const element = renderSentenceText(sentence('s1', 'Alpha', { hidden: true }), { onSplit: () => {} });
  assert.equal(element.querySelector('.sentence-mask').textContent.length, 5);
  assert.deepEqual(markersOf(element), []);
});

// ---- Selecting and merging ----

const selectBoxes = (container) => [...container.querySelectorAll('.row-select')];
const tick = (container, index) => {
  const box = selectBoxes(container)[index];
  box.checked = !box.checked;
  box.dispatchEvent(new dom.window.Event('change'));
};
const settle = () => new Promise((r) => setTimeout(r, 0));

test('rows are numbered from one, in two digits', () => {
  const h = harness(session([sentence('s1', 'One.'), sentence('s2', 'Two.')]));
  assert.deepEqual([...h.container.querySelectorAll('.row-index-num')].map((n) => n.textContent), ['01', '02']);
});

test('the merge bar appears with one tick, and offers Merge only from two', () => {
  const h = harness(session([sentence('s1', 'One.'), sentence('s2', 'Two.')]));
  const bar = h.container.querySelector('.merge-bar');
  assert.equal(bar.hidden, true, 'nothing selected, nothing to say');

  tick(h.container, 0);
  assert.equal(bar.hidden, false);
  assert.equal(bar.querySelector('.merge-bar-label').textContent, '1 selected');
  assert.equal(buttonIn(bar, 'Merge').hidden, true, 'one sentence is not a merge');

  tick(h.container, 1);
  assert.equal(buttonIn(bar, 'Merge').hidden, false);
});

test('merging dispatches the ticked ids in session order, not the order they were ticked', async () => {
  const h = harness(session([sentence('s1', 'One.'), sentence('s2', 'Two.'), sentence('s3', 'Three.')]));
  tick(h.container, 2);
  tick(h.container, 1);

  buttonIn(h.container.querySelector('.merge-bar'), 'Merge').click();
  await settle();

  assert.deepEqual(h.dispatched.at(-1), ['merge', ['s2', 's3']]);
});

test('a merge that succeeds clears the selection and says what happened', async () => {
  const h = harness(
    session([sentence('s1', 'One.'), sentence('s2', 'Two.')]),
    { merge: async (ids) => ({ ok: true, audioFollowed: null, added: ['s9'], ids }) },
  );
  tick(h.container, 0);
  tick(h.container, 1);

  buttonIn(h.container.querySelector('.merge-bar'), 'Merge').click();
  await settle();

  assert.equal(h.container.querySelector('.merge-bar').hidden, true);
  assert.deepEqual(selectBoxes(h.container).map((b) => b.checked), [false, false]);
  assert.match(h.container.querySelector('.practice-status').textContent, /Merged 2 sentences/);
});

test('a sentence that would break the run cannot be ticked at all', () => {
  const h = harness(session([sentence('s1', 'One.'), sentence('s2', 'Two.'), sentence('s3', 'Three.'), sentence('s4', 'Four.')]));
  assert.deepEqual(selectBoxes(h.container).map((b) => b.disabled), [false, false, false, false], 'anything may start a selection');

  tick(h.container, 1);
  assert.deepEqual(selectBoxes(h.container).map((b) => b.disabled), [false, false, false, true]);

  tick(h.container, 2);
  assert.deepEqual(
    selectBoxes(h.container).map((b) => b.disabled),
    [false, false, false, false],
    'both neighbours extend the run, and both ends can give it up',
  );
});

test('a sentence in the middle of the run cannot be unticked, which would leave a hole', () => {
  const h = harness(session([sentence('s1', 'One.'), sentence('s2', 'Two.'), sentence('s3', 'Three.')]));
  tick(h.container, 0);
  tick(h.container, 1);
  tick(h.container, 2);

  assert.deepEqual(selectBoxes(h.container).map((b) => b.disabled), [false, true, false]);
});

test('a refusal from the command is still reported, and leaves the selection alone', async () => {
  // Unreachable from the controls now that the selection is held to a run, but
  // the command refuses on its own account -- a sync can land between the tick
  // and the click -- and the user has to be told.
  const h = harness(
    session([sentence('s1', 'One.'), sentence('s2', 'Two.')]),
    { merge: async () => ({ ok: false, reason: 'not-adjacent' }) },
  );
  tick(h.container, 0);
  tick(h.container, 1);

  buttonIn(h.container.querySelector('.merge-bar'), 'Merge').click();
  await settle();

  assert.match(h.container.querySelector('.practice-status').textContent, /not next to each other/);
  assert.deepEqual(selectBoxes(h.container).map((b) => b.checked), [true, true], 'so it can be corrected, not redone');
});

test('a tick survives a repaint, which is what a background sync causes', () => {
  const h = harness(session([sentence('s1', 'One.'), sentence('s2', 'Two.')]));
  tick(h.container, 0);

  h.store.apply((s) => updateSentence(s, 's2', { lang: 'ja' }, 5));

  assert.deepEqual(selectBoxes(h.container).map((b) => b.checked), [true, false]);
});

test('a sentence that goes away is not left selected in the background', () => {
  const h = harness(session([sentence('s1', 'One.'), sentence('s2', 'Two.')]));
  tick(h.container, 0);
  tick(h.container, 1);

  h.store.replace(session([sentence('s2', 'Two.')]));

  assert.equal(h.container.querySelector('.merge-bar-label').textContent, '1 selected');
  assert.deepEqual(selectBoxes(h.container).map((b) => b.checked), [true]);
});

test('Clear drops the selection without merging anything', () => {
  const h = harness(session([sentence('s1', 'One.'), sentence('s2', 'Two.')]));
  tick(h.container, 0);

  buttonIn(h.container.querySelector('.merge-bar'), 'Clear').click();

  assert.equal(h.container.querySelector('.merge-bar').hidden, true);
  assert.deepEqual(h.dispatched, []);
});
