import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptySession, startNew, splitTypedText, open, reopenLast, describe, remove, applyIncoming, startsHidden,
} from '../../js/app/commands/session.js';
import { createSessionStore } from '../../js/app/store.js';
import { blankSentence } from '../../js/model/session.js';

function harness({ stored = {} } = {}) {
  const records = new Map(Object.entries(stored));
  const released = [];
  const resets = [];
  let lastSessionId = null;
  let n = 0;

  return {
    records,
    released,
    resets,
    lastSessionId: () => lastSessionId,
    store: createSessionStore(),
    deps: {
      ids: () => `id-${++n}`,
      clock: () => 1000,
      release: () => released.push('released'),
      autosave: { reset: (known) => resets.push(known) },
      settings: {
        lastSessionId: () => lastSessionId,
        saveLastSessionId: (id) => { lastSessionId = id; },
      },
      db: {
        getOne: async (entity, id) => records.get(id) ?? undefined,
        remove: async (entity, id) => { records.delete(id); },
      },
    },
  };
}

const storedSession = (over = {}) => ({
  ...emptySession({ id: 'sess1', now: 1 }),
  sentences: [blankSentence({ id: 's1', text: 'stored', lang: 'en', now: 1 })],
  ...over,
});

test('emptySession: sets every field the schema names', () => {
  const session = emptySession({ id: 'x', now: 5 });
  assert.deepEqual(Object.keys(session).sort(), [
    'createdAt', 'id', 'inputText', 'inputTextHash', 'metaUpdatedAt',
    'name', 'sentences', 'sortKey', 'sourceAudio', 'sourceAudioHash', 'splitMode', 'updatedAt',
  ]);
  assert.equal(session.splitMode, 'auto');
});

test('startNew: puts a blank session on screen and releases what was held', () => {
  const h = harness();
  h.store.replace(storedSession());

  startNew({ store: h.store, deps: h.deps });

  assert.deepEqual(h.store.get().sentences, []);
  assert.equal(h.store.get().id, 'id-1');
  assert.deepEqual(h.released, ['released'], 'recorders and playback were released');
  assert.deepEqual(h.resets, [null], 'autosave assumes nothing about the new one');
});

test('startNew: an audio session is left behind completely, not partially', () => {
  // The bug this command exists to prevent: a partial copy of this workflow
  // elsewhere left splitMode on 'audio', so the text box stayed hidden with no
  // sentences on screen.
  const h = harness();
  h.store.replace({ ...storedSession(), splitMode: 'audio', sourceAudio: 'BIG_FILE', sourceAudioHash: 'h' });

  startNew({ store: h.store, deps: h.deps });

  const now = h.store.get();
  assert.equal(now.splitMode, 'auto', 'so the text box is usable again');
  assert.equal(now.sourceAudio, null, 'and the source file is not held on to');
  assert.equal(now.sourceAudioHash, null);
});

test('splitTypedText: makes one sentence per piece and keeps the text as typed', () => {
  const h = harness();
  const result = splitTypedText({ store: h.store, text: 'One. Two.', deps: h.deps });

  assert.equal(result.count, 2);
  assert.deepEqual(h.store.get().sentences.map((s) => s.text), ['One.', 'Two.']);
  assert.equal(h.store.get().inputText, 'One. Two.', 'kept for the next edit');
  assert.equal(h.store.get().splitMode, 'auto');
});

test('splitTypedText: each sentence gets its own id', () => {
  const h = harness();
  splitTypedText({ store: h.store, text: 'One. Two. Three.', deps: h.deps });
  const ids = h.store.get().sentences.map((s) => s.id);
  assert.equal(new Set(ids).size, 3);
});

test('splitTypedText: text that segments to nothing is refused', () => {
  const h = harness();
  assert.deepEqual(splitTypedText({ store: h.store, text: '   \n ', deps: h.deps }), { ok: false, reason: 'no-text' });
  assert.equal(h.store.get(), null, 'and nothing was put on screen');
});

test('splitTypedText: each sentence gets the language of its own text', () => {
  // A pasted lesson is regularly both: a Japanese line and its English gloss.
  // One language for the whole block means half of it is read in the wrong
  // voice, which is the first thing a user notices.
  const h = harness();
  splitTypedText({ store: h.store, text: '今日はいい天気ですね。\nThe weather is lovely today.', deps: h.deps });
  assert.deepEqual(h.store.get().sentences.map((s) => s.lang), ['ja', 'en']);
});

test('splitTypedText: an explicit language overrides detection', () => {
  const h = harness();
  splitTypedText({ store: h.store, text: '今日は。はい。', lang: 'ja', deps: h.deps });
  assert.deepEqual(h.store.get().sentences.map((s) => s.lang), ['ja', 'ja']);
});

test('open: puts the stored record on screen unchanged, and remembers it', async () => {
  const h = harness({ stored: { sess1: storedSession() } });

  const result = await open({ store: h.store, sessionId: 'sess1', deps: h.deps });

  assert.equal(result.ok, true);
  assert.equal(h.store.get().sentences[0].text, 'stored');
  assert.equal(h.lastSessionId(), 'sess1');
  assert.deepEqual(h.resets, [h.records.get('sess1')], 'autosave is told what is already stored');
  assert.deepEqual(h.released, ['released']);
});

test('open: a session that is not there is reported, and the screen is left alone', async () => {
  const h = harness();
  h.store.replace(storedSession({ id: 'other' }));

  const result = await open({ store: h.store, sessionId: 'missing', deps: h.deps });

  assert.deepEqual(result, { ok: false, reason: 'not-found' });
  assert.equal(h.store.get().id, 'other');
  assert.deepEqual(h.released, [], 'nothing was released for an open that did not happen');
});

test('reopenLast: brings back what was last open', async () => {
  const h = harness({ stored: { sess1: storedSession() } });
  h.deps.settings.saveLastSessionId('sess1');

  await reopenLast({ store: h.store, deps: h.deps });
  assert.equal(h.store.get().id, 'sess1');
});

test('reopenLast: with nothing remembered it starts fresh', async () => {
  const h = harness();
  await reopenLast({ store: h.store, deps: h.deps });
  assert.deepEqual(h.store.get().sentences, []);
});

test('reopenLast: a session deleted since is not an error, just a blank one', async () => {
  const h = harness();
  h.deps.settings.saveLastSessionId('deleted-elsewhere');

  await reopenLast({ store: h.store, deps: h.deps });

  assert.deepEqual(h.store.get().sentences, []);
  assert.equal(h.lastSessionId(), null, 'and the stale id is forgotten');
});

test('describe: renaming moves both clocks, because a session field changed', () => {
  const h = harness();
  h.store.replace(storedSession());

  describe({ store: h.store, patch: { name: 'Lesson 3' }, deps: h.deps });

  assert.equal(h.store.get().name, 'Lesson 3');
  assert.equal(h.store.get().metaUpdatedAt, 1000);
});

test('describe: with nothing on screen it simply does not apply', () => {
  const h = harness();
  assert.deepEqual(describe({ store: h.store, patch: { name: 'x' }, deps: h.deps }), { ok: false });
});

test('remove: deletes the record and moves the screen off it', async () => {
  const h = harness({ stored: { sess1: storedSession() } });
  await open({ store: h.store, sessionId: 'sess1', deps: h.deps });

  const result = await remove({ store: h.store, sessionId: 'sess1', deps: h.deps });

  assert.equal(result.wasOnScreen, true);
  assert.equal(h.records.has('sess1'), false);
  assert.deepEqual(h.store.get().sentences, [], 'a blank session, not one that no longer exists');
  assert.equal(h.lastSessionId(), null, 'and it will not be reopened on the next load');
});

test('remove: deleting a session that is not on screen leaves the screen alone', async () => {
  const h = harness({ stored: { sess1: storedSession(), sess2: storedSession({ id: 'sess2' }) } });
  await open({ store: h.store, sessionId: 'sess1', deps: h.deps });

  const result = await remove({ store: h.store, sessionId: 'sess2', deps: h.deps });

  assert.equal(result.wasOnScreen, false);
  assert.equal(h.store.get().id, 'sess1');
});

test('applyIncoming: a newer copy of the session on screen replaces it', () => {
  const h = harness();
  h.store.replace(storedSession({ updatedAt: 10 }));

  const incoming = storedSession({ updatedAt: 50, name: 'renamed elsewhere' });
  assert.equal(applyIncoming({ store: h.store, session: incoming, deps: h.deps }).ok, true);
  assert.equal(h.store.get().name, 'renamed elsewhere');
  assert.deepEqual(h.resets, [incoming]);
});

test('applyIncoming: a session the user has since left is not forced on them', () => {
  const h = harness();
  h.store.replace(storedSession({ id: 'other' }));

  const result = applyIncoming({ store: h.store, session: storedSession({ id: 'sess1' }), deps: h.deps });

  assert.deepEqual(result, { ok: false, reason: 'not-on-screen' });
  assert.equal(h.store.get().id, 'other');
});

test('applyIncoming: an older copy never overwrites newer local work', () => {
  const h = harness();
  h.store.replace(storedSession({ updatedAt: 500, name: 'local edit' }));

  const result = applyIncoming({ store: h.store, session: storedSession({ updatedAt: 100 }), deps: h.deps });

  assert.deepEqual(result, { ok: false, reason: 'local-is-newer' });
  assert.equal(h.store.get().name, 'local edit');
});

test('applyIncoming: a copy that says nothing new leaves the screen alone', () => {
  // Every successful sync round offers the stored copy back. It is a fresh
  // read, so its Blobs are new objects -- and putting it in place would move
  // the version, which is what a score or a split in flight is pinned to.
  const h = harness();
  const take = new Blob([new Uint8Array([1, 2])], { type: 'audio/wav' });
  const onScreen = storedSession({ updatedAt: 10 });
  onScreen.sentences[0].recording = take;
  onScreen.sentences[0].recordingHash = 'h1';
  h.store.replace(onScreen);
  const version = h.store.version();

  const reread = storedSession({ updatedAt: 10 });
  reread.sentences[0].recording = new Blob([new Uint8Array([1, 2])], { type: 'audio/wav' });
  reread.sentences[0].recordingHash = 'h1';

  const result = applyIncoming({ store: h.store, session: reread, deps: h.deps });

  assert.deepEqual(result, { ok: false, reason: 'unchanged' });
  assert.equal(h.store.get(), onScreen, 'the same object, so the recording is still the one a score compares against');
  assert.equal(h.store.version(), version, 'and nothing in flight is superseded by it');
  assert.deepEqual(h.resets, [], 'autosave keeps what it last wrote');
});

test('applyIncoming: a copy whose content changed under the same clock still lands', () => {
  // The clock alone cannot tell: a round can merge in a child whose own clock
  // is newer without the session's moving past the local one. The hashes can.
  const h = harness();
  h.store.replace(storedSession({ updatedAt: 10 }));

  const incoming = storedSession({ updatedAt: 10 });
  incoming.sentences[0].recordingHash = 'from-another-device';

  assert.equal(applyIncoming({ store: h.store, session: incoming, deps: h.deps }).ok, true);
  assert.equal(h.store.get().sentences[0].recordingHash, 'from-another-device');
});

test('applyIncoming: with nothing on screen there is nothing to update', () => {
  const h = harness();
  assert.equal(applyIncoming({ store: h.store, session: storedSession(), deps: h.deps }).ok, false);
});

test('startsHidden: new sentences follow the global switch, from one rule', () => {
  assert.equal(startsHidden({ hideText: () => true }), true);
  assert.equal(startsHidden({ hideText: () => false }), false);
  assert.equal(startsHidden({}), false, 'settings without the preference at all');
  assert.equal(startsHidden(undefined), false);
});

test('splitTypedText: text split while practising from memory arrives hidden', () => {
  const h = harness();
  h.deps.settings.hideText = () => true;

  splitTypedText({ store: h.store, text: 'One. Two.', deps: h.deps });

  assert.deepEqual(h.store.get().sentences.map((s) => s.hidden), [true, true]);
});
