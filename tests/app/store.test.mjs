import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from '../../js/app/store.js';
import { updateSentence, splitSentence, blankSentence } from '../../js/model/session.js';

const sentence = (id, text) => blankSentence({ id, text, lang: 'en', now: 1 });
const session = (sentences = []) => ({
  id: 'sess1', name: null, folderId: null, splitMode: 'auto',
  createdAt: 1, updatedAt: 1, metaUpdatedAt: 1,
  inputText: null, inputTextHash: null, sourceAudio: null, sourceAudioHash: null,
  sentences,
});

test('starts empty at version 0, or with what it was given', () => {
  assert.equal(createSessionStore().get(), null);
  assert.equal(createSessionStore().version(), 0);
  assert.equal(createSessionStore(session()).get().id, 'sess1');
});

test('apply: replaces the value and counts the change', () => {
  const store = createSessionStore(session([sentence('a', 'one')]));
  const changed = store.apply((s) => updateSentence(s, 'a', { hidden: true }, 100));

  assert.equal(changed, true);
  assert.equal(store.get().sentences[0].hidden, true);
  assert.equal(store.version(), 1);
});

test('apply: the change sees the CURRENT session, not one captured earlier', () => {
  // The point of the whole design. A command reads, waits, then applies; by
  // then the session has moved on, and its change must be computed against what
  // is actually there.
  const store = createSessionStore(session([sentence('a', 'one')]));
  const stale = store.get();

  store.apply((s) => updateSentence(s, 'a', { hidden: true }, 100));
  store.apply((current) => {
    assert.notEqual(current, stale, 'the change is handed the current value');
    assert.equal(current.sentences[0].hidden, true, 'including the edit that landed meanwhile');
    return updateSentence(current, 'a', { lang: 'ja' }, 200);
  });

  assert.equal(store.get().sentences[0].hidden, true, 'the earlier edit survived');
  assert.equal(store.get().sentences[0].lang, 'ja');
});

test('apply: a change returning null leaves everything alone', () => {
  const store = createSessionStore(session());
  assert.equal(store.apply(() => null), false);
  assert.equal(store.version(), 0);
  assert.ok(store.get());
});

test('apply: a change returning the same object is not a change', () => {
  // The model returns its input when asked to edit something that is gone.
  // Counting that would repaint the screen for nothing.
  const store = createSessionStore(session([sentence('a', 'one')]));
  const notified = [];
  store.subscribe(() => notified.push(store.version()));

  assert.equal(store.apply((s) => updateSentence(s, 'not-here', { hidden: true }, 100)), false);
  assert.equal(store.version(), 0);
  assert.deepEqual(notified, []);
});

test('applyIfUnchanged: applies while the version still matches', () => {
  const store = createSessionStore(session([sentence('a', 'one')]));
  const at = store.version();

  assert.equal(store.applyIfUnchanged(at, (s) => updateSentence(s, 'a', { hidden: true }, 100)), true);
  assert.equal(store.get().sentences[0].hidden, true);
});

test('applyIfUnchanged: refuses once anything else has landed', () => {
  // A split finishes decoding audio, but a sync arrived first. Its result
  // describes a session that no longer exists, so it is dropped.
  const store = createSessionStore(session([sentence('a', 'one')]));
  const startedAt = store.version();

  store.replace(session([sentence('a', 'one'), sentence('b', 'two')]), 'sync');

  const applied = store.applyIfUnchanged(startedAt, (s) => updateSentence(s, 'a', { lang: 'ja' }, 300));
  assert.equal(applied, false);
  assert.equal(store.get().sentences.length, 2, 'the newer state is intact');
  assert.equal(store.get().sentences[0].lang, 'en', 'and the stale edit was not applied');
});

test('applyIfUnchanged: a refusal is reported, so the caller can say what happened', () => {
  const store = createSessionStore(session());
  store.replace(session(), 'other');
  assert.equal(store.applyIfUnchanged(0, (s) => ({ ...s, name: 'x' })), false);
});

test('a slow split that is beaten by another edit does not undo it', () => {
  // End to end, with the real model transform: the ordering that used to
  // corrupt the sentence list when an index was captured before an await.
  const store = createSessionStore(session([sentence('a', 'Alpha beta'), sentence('b', 'second')]));
  const startedAt = store.version();

  // While the audio decode runs, the user hides the other sentence.
  store.apply((s) => updateSentence(s, 'b', { hidden: true }, 200));

  const applied = store.applyIfUnchanged(startedAt, (s) => splitSentence(s, {
    sentenceId: 'a', charIndex: 6, leftId: 'L', rightId: 'R', now: 300,
  })?.session ?? null);

  assert.equal(applied, false);
  assert.deepEqual(store.get().sentences.map((s) => s.id), ['a', 'b']);
  assert.equal(store.get().sentences[1].hidden, true, 'the edit that won is untouched');
});

test('a slow split applied by id still lands correctly after the list moved', () => {
  // The other half of the design: when the command re-resolves by id rather
  // than pinning a version, it finds its sentence wherever it now is.
  const store = createSessionStore(session([sentence('a', 'first'), sentence('b', 'Alpha beta')]));
  store.apply((s) => ({ ...s, sentences: [sentence('c', 'inserted'), ...s.sentences] }));

  const applied = store.apply((s) => splitSentence(s, {
    sentenceId: 'b', charIndex: 6, leftId: 'L', rightId: 'R', now: 300,
  })?.session ?? null);

  assert.equal(applied, true);
  assert.deepEqual(store.get().sentences.map((s) => s.id), ['c', 'a', 'L', 'R']);
});

test('replace: puts a whole session in place and counts it', () => {
  const store = createSessionStore();
  assert.equal(store.replace(session([sentence('a', 'one')])), true);
  assert.equal(store.version(), 1);
  assert.equal(store.get().sentences.length, 1);
});

test('replace: null clears the session, which apply deliberately cannot do', () => {
  const store = createSessionStore(session());
  assert.equal(store.replace(null), true);
  assert.equal(store.get(), null);
  assert.equal(store.version(), 1);
});

test('replace: replacing with the identical object is not a change', () => {
  const only = session();
  const store = createSessionStore(only);
  assert.equal(store.replace(only), false);
  assert.equal(store.version(), 0);
});

test('subscribe: listeners hear each change with the version and the reason', () => {
  const store = createSessionStore(session());
  const heard = [];
  store.subscribe((s, meta) => heard.push([s?.name ?? null, meta.version, meta.reason]));

  store.apply((s) => ({ ...s, name: 'one' }), 'rename');
  store.replace(null, 'cleared');

  assert.deepEqual(heard, [['one', 1, 'rename'], [null, 2, 'cleared']]);
});

test('subscribe: returns an unsubscribe that actually stops delivery', () => {
  const store = createSessionStore(session());
  let count = 0;
  const off = store.subscribe(() => { count++; });

  store.apply((s) => ({ ...s, name: 'one' }));
  off();
  store.apply((s) => ({ ...s, name: 'two' }));

  assert.equal(count, 1);
});

test('subscribe: unsubscribing from inside a notification does not disturb the others', () => {
  const store = createSessionStore(session());
  const heard = [];
  let off;
  off = store.subscribe(() => { heard.push('first'); off(); });
  store.subscribe(() => heard.push('second'));

  store.apply((s) => ({ ...s, name: 'x' }));
  assert.deepEqual(heard, ['first', 'second']);

  store.apply((s) => ({ ...s, name: 'y' }));
  assert.deepEqual(heard, ['first', 'second', 'second']);
});

test('subscribe: a listener added during a notification is not called for that same change', () => {
  const store = createSessionStore(session());
  const heard = [];
  store.subscribe(() => {
    heard.push('outer');
    store.subscribe(() => heard.push('inner'));
  });

  store.apply((s) => ({ ...s, name: 'x' }));
  assert.deepEqual(heard, ['outer']);
});

test('listeners see the new value, not the one being replaced', () => {
  const store = createSessionStore(session());
  let seen;
  store.subscribe((s) => { seen = s; });
  store.apply((s) => ({ ...s, name: 'after' }));
  assert.equal(seen.name, 'after');
  assert.equal(seen, store.get());
});
