// The word picker: what it offers, what it says the selection will produce,
// and the one thing it must not do -- record a group twice when a first
// attempt failed partway through.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;

const { vocabPicker, describeSelection, unplaced } = await import('../../js/ui/panels/practice/vocab-picker.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const chips = () => [...document.querySelectorAll('.vocab-word')];
const chipNamed = (text) => chips().find((chip) => chip.textContent === text);
const actionNamed = (label) => [...document.querySelectorAll('.modal-actions button')]
  .find((button) => button.textContent === label);
const hint = () => document.querySelector('.vocab-picker .modal-message').textContent;
const status = () => document.querySelector('.vocab-status');

// Word spans as the service reports them: a sentence without any is not
// offered a picker at all (see row.js).
const WORDS = [
  { charStart: 0, charEnd: 3, offsetMs: 0, durationMs: 200 },
  { charStart: 4, charEnd: 7, offsetMs: 200, durationMs: 200 },
  { charStart: 8, charEnd: 13, offsetMs: 400, durationMs: 300 },
];

const sentence = (over = {}) => ({ id: 's1', text: 'one two three', lang: 'en', words: WORDS, ...over });

beforeEach(() => document.body.replaceChildren());

test('the sentence arrives as one chip per word', () => {
  vocabPicker({ sentence: sentence(), addGroups: async () => ({ ok: true, added: 1 }) });
  assert.deepEqual(chips().map((chip) => chip.textContent), ['one', 'two', 'three']);
});

test('Add is refused until something is picked', () => {
  vocabPicker({ sentence: sentence(), addGroups: async () => ({ ok: true, added: 1 }) });
  assert.equal(actionNamed('Add').disabled, true);

  chipNamed('two').click();
  assert.equal(actionNamed('Add').disabled, false);

  chipNamed('two').click();
  assert.equal(actionNamed('Add').disabled, true, 'and refused again when it is unpicked');
});

test('a chip says whether it is picked, in the markup rather than only in colour', () => {
  vocabPicker({ sentence: sentence(), addGroups: async () => ({ ok: true, added: 1 }) });
  const chip = chipNamed('one');

  chip.click();
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
  assert.ok(chip.classList.contains('is-selected'));

  chip.click();
  assert.equal(chip.getAttribute('aria-pressed'), 'false');
});

// ---- what the selection will produce, said before it is produced ----

test('words that touch are one entry; words that do not are separate ones', () => {
  const text = 'one two three';
  const units = WORDS;

  assert.match(describeSelection(text, units, [0, 1]), /One entry: “one two”/);
  assert.match(describeSelection(text, units, [0, 2]), /2 entries: “one”, “three”/);
  assert.match(describeSelection(text, units, []), /Click the words you want to keep/);
});

test('the account names the same word the chip shows, after an astral character too', () => {
  // Spans are in characters; the chip is cut in characters; the account must
  // be cut the same way or it names a different word from the one picked.
  const text = '𠮷野家で 食べた';
  const units = [{ charStart: 0, charEnd: 4 }, { charStart: 5, charEnd: 8 }];
  assert.match(describeSelection(text, units, [1]), /One entry: “食べた”/);
});

test('the picker shows that account as the selection changes', () => {
  vocabPicker({ sentence: sentence(), addGroups: async () => ({ ok: true, added: 1 }) });

  chipNamed('one').click();
  chipNamed('two').click();
  assert.match(hint(), /One entry: “one two”/);

  chipNamed('three').click();
  assert.match(hint(), /One entry: “one two three”/);

  chipNamed('two').click();
  assert.match(hint(), /2 entries: “one”, “three”/);
});

// ---- adding ----

test('adding hands over one group per run of picked words, and closes', async () => {
  const handed = [];
  const result = vocabPicker({
    sentence: sentence(),
    addGroups: async (groups) => { handed.push(groups); return { ok: true, added: groups.length }; },
  });

  chipNamed('one').click();
  chipNamed('three').click();
  actionNamed('Add').click();
  const outcome = await result;

  assert.equal(handed.length, 1);
  assert.deepEqual(handed[0].map((group) => group.map((unit) => [unit.charStart, unit.charEnd])),
    [[[0, 3]], [[8, 13]]]);
  assert.deepEqual(outcome, { added: 2 });
  assert.equal(document.querySelector('.modal-backdrop'), null, 'and the modal is gone');
});

test('a failure partway through is retried from where it stopped, never from the start', async () => {
  // An occurrence is an append-only fact: addOccurrence has nothing to
  // recognise a repeat by, so a retry that re-sent the groups that already
  // succeeded would record them twice.
  const handed = [];
  let attempt = 0;
  const result = vocabPicker({
    sentence: sentence(),
    addGroups: async (groups) => {
      handed.push(groups.map((group) => group[0].charStart));
      attempt += 1;
      return attempt === 1
        ? { ok: false, added: 1, reason: 'Storing vocab v1 failed: HTTP 500' }
        : { ok: true, added: groups.length };
    },
  });

  chipNamed('one').click();
  chipNamed('three').click();
  actionNamed('Add').click();
  await tick();

  assert.deepEqual(handed[0], [0, 8], 'both groups on the first attempt');
  assert.match(status().textContent, /1 of 2 went in; pressing Add again continues from there/);
  assert.equal(status().dataset.kind, 'error');
  assert.equal(actionNamed('Add').disabled, false, 'and Add is pressable again');

  actionNamed('Add').click();
  const outcome = await result;

  assert.deepEqual(handed[1], [8], 'only the one that had not gone in');
  assert.deepEqual(outcome, { added: 2 });
});

test('the selection is frozen once Add has been pressed, so the count still means something', async () => {
  const result = vocabPicker({
    sentence: sentence(),
    addGroups: async () => ({ ok: false, added: 1, reason: 'nope' }),
  });

  chipNamed('one').click();
  chipNamed('three').click();
  actionNamed('Add').click();
  await tick();

  chipNamed('two').click();
  assert.equal(chipNamed('two').getAttribute('aria-pressed'), 'false',
    'a selection that changed under a half-finished add would desync the count');

  actionNamed('Cancel').click();
  assert.equal(await result, null);
});

test('cancelling records nothing and says so by resolving to nothing', async () => {
  const handed = [];
  const result = vocabPicker({
    sentence: sentence(),
    addGroups: async (groups) => { handed.push(groups); return { ok: true, added: 1 }; },
  });

  chipNamed('one').click();
  actionNamed('Cancel').click();

  assert.equal(await result, null);
  assert.deepEqual(handed, []);
});

test('the chips are the service\'s own spans, whatever the spaces say', () => {
  const words = [
    { charStart: 0, charEnd: 7, offsetMs: 0, durationMs: 400 },
    { charStart: 8, charEnd: 13, offsetMs: 400, durationMs: 300 },
  ];
  vocabPicker({ sentence: sentence({ text: 'one two three', words }), addGroups: async () => ({ ok: true, added: 1 }) });

  assert.deepEqual(chips().map((chip) => chip.textContent), ['one two', 'three']);
});

// ---- words the reading did not place ----

test('unplaced: the words no unit covers', () => {
  assert.deepEqual(unplaced('Hello A B C D E', [{ charStart: 0, charEnd: 5 }]), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(unplaced('one two', [{ charStart: 0, charEnd: 3 }, { charStart: 4, charEnd: 7 }]), []);
});

test('the picker says which words the reading did not place', async () => {
  // Reported as "where did my A B C D E go": the reading placed only the
  // first word, so only the first word could be picked, and nothing said so.
  vocabPicker({
    sentence: { id: 's1', text: 'Hello A B C D E', lang: 'en', words: [{ charStart: 0, charEnd: 5, offsetMs: 0, durationMs: 300 }] },
    addGroups: async () => ({ ok: true, added: 1 }),
  });

  assert.deepEqual(chips().map((chip) => chip.textContent), ['Hello']);
  const note = document.querySelector('.vocab-unplaced').textContent;
  assert.match(note, /did not place 5 words of this sentence \(A, B, C, D, E\)/);
  assert.match(note, /Speaking the sentence again may place them/);
});

test('nothing is said when the reading placed everything', () => {
  vocabPicker({ sentence: sentence(), addGroups: async () => ({ ok: true, added: 1 }) });
  assert.equal(document.querySelector('.vocab-unplaced'), null);
});

test('unplaced: counts in characters, so a surrogate pair is one position', () => {
  // A word span comes from model/transcript.js, which counts code points; an
  // array sized in UTF-16 units and read with those indices is two different
  // rulers laid against the same text.
  assert.deepEqual(unplaced('\u{20B9F}る こと', [{ charStart: 0, charEnd: 2 }]), ['こと']);
});
