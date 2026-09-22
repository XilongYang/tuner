// The whole decision surface of bidirectional sync, tested with object
// literals: no fake container, no IndexedDB, no jsdom, no module mocking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSync, slotsFor, orphanPaths, emptyManifest, MANIFEST_VERSION } from '../../js/cloud/sync/plan.js';

const emptyLocal = () => ({ sessions: [], vocab: [], tombstones: [] });

const session = (over = {}) => ({
  id: 'sess1', name: null, splitMode: 'auto',
  createdAt: 1, updatedAt: 10, metaUpdatedAt: 10,
  inputText: null, inputTextHash: null, sourceAudio: null, sourceAudioHash: null,
  sentences: [], ...over,
});

const sentence = (over = {}) => ({
  id: 'sent1', text: 'hello', lang: 'en', hidden: false, updatedAt: 10,
  words: null, referenceSource: null, sourceOffsetMs: null, sourceDurationMs: null,
  recording: null, recordingHash: null, reference: null, referenceHash: null, assessment: null, assessmentHash: null,
  ...over,
});

const plan = (local, remote = null) => planSync({ local: { ...emptyLocal(), ...local }, remote });

test('a first sync of an empty device against an empty container changes nothing', () => {
  const p = plan({}, null);
  assert.equal(p.manifestChanged, false, 'no pointless upload of an empty manifest');
  assert.deepEqual(p.slots, []);
  assert.deepEqual(p.localWrites, []);
  assert.deepEqual(p.localDeletes, []);
});

test('a local session with a recording uploads its content and publishes a manifest', () => {
  const p = plan({
    sessions: [session({ inputTextHash: 'ih', inputText: 'hello', sentences: [sentence({ recordingHash: 'rh' })] })],
  });
  assert.equal(p.manifestChanged, true);
  assert.deepEqual(slotsFor(p, 'upload').map((s) => s.path), [
    'inputtext/sess1.txt',
    'recordings/sess1/sent1.wav',
  ]);
  assert.deepEqual(slotsFor(p, 'download'), []);
  assert.equal(p.manifest.version, MANIFEST_VERSION);
  assert.equal(p.manifest.sessions[0].sentences[0].recordingHash, 'rh');
});

test('re-planning against the manifest just published needs no work at all', () => {
  const local = {
    sessions: [session({ inputTextHash: 'ih', inputText: 'hello', sentences: [sentence({ recordingHash: 'rh' })] })],
  };
  const first = plan(local);
  const second = plan(local, first.manifest);

  assert.equal(second.manifestChanged, false, 'the no-op round must not re-upload the manifest');
  assert.deepEqual(slotsFor(second, 'upload'), [], 'nor re-upload unchanged content');
  assert.deepEqual(slotsFor(second, 'download'), []);
  assert.deepEqual(slotsFor(second, 'reuse').map((s) => s.path), [
    'inputtext/sess1.txt', 'recordings/sess1/sent1.wav',
  ]);
});

test('a second device with an empty store downloads everything and writes it locally', () => {
  const published = plan({
    sessions: [session({ inputTextHash: 'ih', inputText: 'hello', sentences: [sentence({ recordingHash: 'rh' })] })],
  }).manifest;

  const p = plan({}, published);
  assert.deepEqual(slotsFor(p, 'download').map((s) => s.path), [
    'inputtext/sess1.txt', 'recordings/sess1/sent1.wav',
  ]);
  assert.equal(p.localWrites.length, 1);
  assert.equal(p.localWrites[0].entity, 'sessions');
  assert.equal(p.localWrites[0].baseClock, null, 'new to this device -- nothing to race against');
  assert.equal(p.manifestChanged, false, 'pulling does not rewrite the container');
});

test('content the other device replaced is downloaded, not reused', () => {
  const remote = plan({ sessions: [session({ sentences: [sentence({ recordingHash: 'newer', updatedAt: 99 })] })] }).manifest;
  const p = plan({ sessions: [session({ sentences: [sentence({ recordingHash: 'older', updatedAt: 5 })] })] }, remote);

  const slot = p.slots.find((s) => s.kind === 'recording');
  assert.equal(slot.action, 'download');
  assert.equal(slot.hash, 'newer');
});

test('content this device replaced is uploaded, not downloaded', () => {
  const remote = plan({ sessions: [session({ sentences: [sentence({ recordingHash: 'older', updatedAt: 5 })] })] }).manifest;
  const p = plan({ sessions: [session({ sentences: [sentence({ recordingHash: 'newer', updatedAt: 99 })] })] }, remote);

  const slot = p.slots.find((s) => s.kind === 'recording');
  assert.equal(slot.action, 'upload');
  assert.equal(slot.hash, 'newer');
});

test('content whose path moved out from under it is surfaced as unresolved, not fetched blindly', () => {
  // A vocab occurrence's audio path is keyed by its entry's audioPathKey. If
  // the two devices disagree about that key, the winning key gives a path
  // where neither side's bytes live -- the occurrence itself survives the
  // union merge, but its audio is genuinely unreachable. Saying so beats
  // issuing a request that 404s inside a download loop.
  // audioPathKey is derived from the entry id, so the two sides agreeing is
  // the norm and this branch is really a corruption detector -- which is the
  // reason it must report rather than guess.
  const local = {
    vocab: [{
      id: 'word', text: 'word', audioPathKey: 'local-key', createdAt: 1, updatedAt: 100,
      sources: [{ occurrenceId: 'occ-local', addedAt: 100, audio: null, audioHash: 'h-local' }],
    }],
  };
  const remote = {
    ...emptyManifest(),
    vocab: [{
      id: 'word', text: 'word', lang: null, audioPathKey: 'remote-key', createdAt: 1, updatedAt: 900,
      sources: [{ occurrenceId: 'occ-remote', sessionId: null, sentenceId: null, sentenceTextSnapshot: null, addedAt: 50, audioHash: 'h-remote' }],
    }],
  };

  const p = plan(local, remote);
  const byPath = new Map(p.slots.map((s) => [s.path, s]));

  // The remote entry is newer, so its key decides every path. The occurrence
  // only this device has therefore points at a path where nothing lives: its
  // bytes are under the old key locally, and were never uploaded under the new
  // one.
  assert.equal(byPath.get('vocab-audio/remote-key/occ-remote.audio').action, 'download');
  assert.equal(byPath.get('vocab-audio/remote-key/occ-local.audio').action, 'unresolved');
  assert.deepEqual(p.unresolved.map((s) => s.path), ['vocab-audio/remote-key/occ-local.audio']);
});

test('the ordinary cases stay ordinary: same hash both sides is reuse, differing is a transfer', () => {
  const remote = plan({ sessions: [session({ sentences: [sentence({ recordingHash: 'h1', updatedAt: 5 })] })] }).manifest;

  const same = plan({ sessions: [session({ sentences: [sentence({ recordingHash: 'h1', updatedAt: 5 })] })] }, remote);
  assert.equal(same.slots.find((s) => s.kind === 'recording').action, 'reuse');
  assert.deepEqual(same.unresolved, []);

  const localNewer = plan({ sessions: [session({ sentences: [sentence({ recordingHash: 'h2', updatedAt: 500 })] })] }, remote);
  assert.equal(localNewer.slots.find((s) => s.kind === 'recording').action, 'upload');
});

test('a locally deleted session propagates as a tombstone and leaves the manifest', () => {
  const remote = plan({ sessions: [session()] }).manifest;
  const p = plan({
    sessions: [],
    tombstones: [{ id: 'session:sess1', kind: 'session', targetId: 'sess1', deletedAt: 500 }],
  }, remote);

  assert.deepEqual(p.manifest.sessions, []);
  assert.ok(p.manifest.tombstones.some((t) => t.id === 'session:sess1'));
  assert.equal(p.manifestChanged, true);
});

test('a tombstone from the container deletes the session here too, and reports it', () => {
  const remote = {
    ...emptyManifest(),
    tombstones: [{ id: 'session:sess1', kind: 'session', targetId: 'sess1', deletedAt: 500 }],
  };
  const p = plan({ sessions: [session({ updatedAt: 100 })] }, remote);

  assert.deepEqual(p.localDeletes, [{ entity: 'sessions', id: 'sess1' }]);
  assert.deepEqual(p.manifest.sessions, []);
  assert.deepEqual(p.localWrites, [], 'a record being deleted is never also written');
});

test('an edit made after a delete wins, and the session comes back', () => {
  const remote = {
    ...emptyManifest(),
    tombstones: [{ id: 'session:sess1', kind: 'session', targetId: 'sess1', deletedAt: 500 }],
  };
  const p = plan({ sessions: [session({ updatedAt: 900 })] }, remote);
  assert.deepEqual(p.localDeletes, []);
  assert.equal(p.manifest.sessions.length, 1);
});

test('content of a session being deleted is never downloaded just to throw it away', () => {
  const remote = {
    ...plan({ sessions: [session({ sentences: [sentence({ recordingHash: 'rh' })] })] }).manifest,
    tombstones: [{ id: 'session:sess1', kind: 'session', targetId: 'sess1', deletedAt: 5000 }],
  };
  const p = plan({}, remote);
  assert.deepEqual(p.slots, []);
  assert.deepEqual(p.referencedPaths, new Set());
});

test('two devices\' vocab occurrences both survive, and the missing audio is downloaded', () => {
  const remoteEntry = {
    id: 'word', text: 'word', lang: 'en', audioPathKey: 'k1', createdAt: 1, updatedAt: 100,
    sources: [{ occurrenceId: 'occ-a', sessionId: 's1', sentenceId: 'x', sentenceTextSnapshot: 'from A', addedAt: 100, audio: null, audioHash: 'ha' }],
  };
  const remote = plan({ vocab: [remoteEntry] }).manifest;

  const p = plan({
    vocab: [{
      ...remoteEntry,
      updatedAt: 200,
      sources: [{ occurrenceId: 'occ-b', sessionId: 's2', sentenceId: 'y', sentenceTextSnapshot: 'from B', addedAt: 200, audio: null, audioHash: 'hb' }],
    }],
  }, remote);

  const entry = p.manifest.vocab[0];
  assert.deepEqual(entry.sources.map((s) => s.occurrenceId), ['occ-a', 'occ-b']);
  assert.deepEqual(slotsFor(p, 'download').map((s) => s.path), ['vocab-audio/k1/occ-a.audio']);
  assert.deepEqual(slotsFor(p, 'upload').map((s) => s.path), ['vocab-audio/k1/occ-b.audio']);
});

test('a vocab entry deleted locally does not come back, and its audio stops being referenced', () => {
  const remote = plan({
    vocab: [{
      id: 'word', text: 'word', audioPathKey: 'k1', createdAt: 1, updatedAt: 100,
      sources: [{ occurrenceId: 'occ-a', addedAt: 100, audioHash: 'ha' }],
    }],
  }).manifest;

  const p = plan({
    vocab: [],
    tombstones: [{ id: 'vocab:word', kind: 'vocab', targetId: 'word', deletedAt: 500 }],
  }, remote);

  assert.deepEqual(p.manifest.vocab, []);
  assert.equal(p.referencedPaths.has('vocab-audio/k1/occ-a.audio'), false);
});

test('every local write carries the clock it was planned against, so the runner can refuse a stale one', () => {
  const p = plan({ sessions: [session({ updatedAt: 42 })] });
  assert.deepEqual(p.localWrites.map((w) => [w.entity, w.id, w.baseClock]), [['sessions', 'sess1', 42]]);
});

test('referencedPaths covers every kind of content the merged result holds', () => {
  const p = plan({
    sessions: [session({
      inputTextHash: 'ih', sourceAudioHash: 'sh',
      sentences: [sentence({ recordingHash: 'rh', referenceHash: 'fh', assessmentHash: 'ah' })],
    })],
    vocab: [{ id: 'w', text: 'w', audioPathKey: 'k', createdAt: 1, updatedAt: 1, sources: [{ occurrenceId: 'o', addedAt: 1, audioHash: 'vh' }] }],
  });
  assert.deepEqual([...p.referencedPaths].sort(), [
    'assessments/sess1/sent1.json',
    'inputtext/sess1.txt',
    'recordings/sess1/sent1.wav',
    'references/sess1/sent1.audio',
    'sourceaudio/sess1.audio',
    'vocab-audio/k/o.audio',
  ]);
});

test('orphanPaths: sweeps only content prefixes, and only what the plan no longer references', () => {
  const referenced = new Set(['recordings/a/b.wav']);
  const existing = [
    'recordings/a/b.wav',      // still referenced
    'recordings/a/old.wav',    // orphan
    'vocab-audio/k/gone.audio', // orphan
    'manifest.json',           // not content -- never swept
    'sync.lock',               // not content -- never swept
  ];
  assert.deepEqual(orphanPaths(referenced, existing), ['recordings/a/old.wav', 'vocab-audio/k/gone.audio']);
});

test('the plan is deterministic: the same inputs give byte-identical manifests', () => {
  const local = {
    sessions: [session({ sentences: [sentence(), sentence({ id: 'sent2', updatedAt: 3 })] })],
    vocab: [{ id: 'w', text: 'w', audioPathKey: 'k', createdAt: 1, updatedAt: 1, sources: [{ occurrenceId: 'o', addedAt: 1 }] }],
  };
  assert.equal(JSON.stringify(plan(local).manifest), JSON.stringify(plan(local).manifest));
});

test('a manifest from a newer version of the app is refused rather than merged', () => {
  // The version has been written on every round since the first one and read by
  // nobody, which makes it decoration. What it is for: a container this code
  // cannot fully understand must not be merged against, because the merge would
  // drop the fields it cannot name and then publish the result as authoritative
  // -- silently, and to every other device.
  const newer = { ...emptyManifest(), version: MANIFEST_VERSION + 1 };

  assert.throws(
    () => planSync({ local: emptyLocal(), remote: newer }),
    (err) => err.incompatible === true && /newer version/.test(err.message),
  );
});

test('a manifest from an older version still plans normally', () => {
  // Only newer is refused. Older is what every upgrade looks like from the
  // other side, and refusing it would make an upgrade unable to sync at all.
  const older = { ...emptyManifest(), version: MANIFEST_VERSION - 1 };
  const plan = planSync({ local: emptyLocal(), remote: older });
  assert.equal(plan.manifest.version, MANIFEST_VERSION);
});
