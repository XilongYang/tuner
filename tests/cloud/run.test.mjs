import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  transferContent, publishManifest, readManifest, sweepOrphans, manifestContentPaths, MANIFEST_PATH,
} from '../../js/cloud/sync/run.js';
import { planSync } from '../../js/cloud/sync/plan.js';
import { fakeContainer } from './fake-container.mjs';

const emptyLocal = () => ({ folders: [], sessions: [], vocab: [], tombstones: [] });
const plan = (local, remote = null) => planSync({ local: { ...emptyLocal(), ...local }, remote });

const session = (over = {}) => ({
  id: 'sess1', name: null, folderId: null, splitMode: 'auto',
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

const blobOf = (bytes) => new Blob([new Uint8Array(bytes)], { type: 'audio/wav' });

test('transferContent: uploads each slot with the MIME type its kind declares', async () => {
  const container = fakeContainer();
  const p = plan({ sessions: [session({ inputTextHash: 'ih', inputText: 'practice text', sentences: [sentence({ recordingHash: 'rh' })] })] });

  const values = new Map([
    ['inputtext/sess1.txt', 'practice text'],
    ['recordings/sess1/sent1.wav', blobOf([1, 2, 3])],
  ]);
  const result = await transferContent(p, container, { getValue: (slot) => values.get(slot.path) });

  assert.deepEqual(result.uploaded.sort(), ['inputtext/sess1.txt', 'recordings/sess1/sent1.wav']);
  assert.equal(container.textOf('inputtext/sess1.txt'), 'practice text');
  assert.deepEqual([...container.bytesOf('recordings/sess1/sent1.wav')], [1, 2, 3]);
});

test('transferContent: a json content kind is uploaded as its serialization and comes back parsed', async () => {
  const container = fakeContainer();
  const assessment = { score: 88, words: [{ word: 'hello', accuracy: 0 }] };

  const upPlan = plan({ sessions: [session({ sentences: [sentence({ assessmentHash: 'ah' })] })] });
  await transferContent(upPlan, container, { getValue: () => assessment });
  assert.deepEqual(container.jsonOf('assessments/sess1/sent1.json'), assessment);

  // A second device downloads the same slot.
  const downPlan = plan({}, upPlan.manifest);
  const result = await transferContent(downPlan, container, { getValue: () => null });
  assert.deepEqual(result.downloaded.get('assessments/sess1/sent1.json'), assessment);
});

test('transferContent: downloads land in a map keyed by path, and the plan is not mutated', async () => {
  const container = fakeContainer();
  const source = plan({ sessions: [session({ sentences: [sentence({ recordingHash: 'rh' })] })] });
  await transferContent(source, container, { getValue: () => blobOf([9, 9]) });

  const p = plan({}, source.manifest);
  const before = JSON.stringify(p.slots);
  const result = await transferContent(p, container, { getValue: () => null });

  assert.equal(result.downloaded.size, 1);
  const got = result.downloaded.get('recordings/sess1/sent1.wav');
  assert.deepEqual([...new Uint8Array(await got.arrayBuffer())], [9, 9]);
  assert.equal(JSON.stringify(p.slots), before, 'transferring content does not rewrite the plan');
});

test('transferContent: reports reused slots without touching the container', async () => {
  const container = fakeContainer();
  const local = { sessions: [session({ sentences: [sentence({ recordingHash: 'rh' })] })] };
  const first = plan(local);
  await transferContent(first, container, { getValue: () => blobOf([1]) });

  const second = plan(local, first.manifest);
  const result = await transferContent(second, container, { getValue: () => { throw new Error('should not be asked'); } });

  assert.deepEqual(result.reused, ['recordings/sess1/sent1.wav']);
  assert.deepEqual(result.uploaded, []);
  assert.equal(result.downloaded.size, 0);
});

test('transferContent: local content that turns out to be absent is reported, not uploaded as nothing', async () => {
  const container = fakeContainer();
  const p = plan({ sessions: [session({ sentences: [sentence({ recordingHash: 'rh' })] })] });

  const result = await transferContent(p, container, { getValue: () => null });

  assert.deepEqual(result.uploaded, []);
  assert.equal(container.has('recordings/sess1/sent1.wav'), false, 'no empty blob written under a hash that claims content');
  assert.deepEqual(result.missing.map((m) => [m.path, m.direction]), [['recordings/sess1/sent1.wav', 'up']]);
});

test('transferContent: a download that is not in the container is reported and the round continues', async () => {
  const container = fakeContainer();
  const source = plan({
    sessions: [session({ sentences: [sentence({ recordingHash: 'rh' }), sentence({ id: 'sent2', recordingHash: 'rh2' })] })],
  });
  // Only one of the two clips actually made it into the container.
  await container.uploadBytes('recordings/sess1/sent2.wav', new Uint8Array([5]), 'audio/wav');

  const p = plan({}, source.manifest);
  const result = await transferContent(p, container, { getValue: () => null });

  assert.equal(result.downloaded.size, 1, 'the reachable one still came down');
  assert.deepEqual(result.missing.map((m) => m.path), ['recordings/sess1/sent1.wav']);
});

test('transferContent: a failure that is not a missing blob aborts, rather than being swallowed', async () => {
  const container = fakeContainer();
  const source = plan({ sessions: [session({ sentences: [sentence({ recordingHash: 'rh' })] })] });
  await transferContent(source, container, { getValue: () => blobOf([1]) });

  const p = plan({}, source.manifest);
  container.downloadBytes = async () => { throw new Error('HTTP 403'); };
  await assert.rejects(() => transferContent(p, container, { getValue: () => null }), /403/);
});

test('transferContent: unresolved slots from the plan are carried into missing', async () => {
  const container = fakeContainer();
  const p = {
    slots: [], unresolved: [{ path: 'vocab-audio/k/o.audio', kind: 'vocabAudio' }],
  };
  const result = await transferContent(p, container, { getValue: () => null });
  assert.deepEqual(result.missing, [{
    path: 'vocab-audio/k/o.audio', direction: 'none', reason: 'hash names content neither side holds',
  }]);
});

test('transferContent: reports progress once per transfer', async () => {
  const container = fakeContainer();
  const p = plan({ sessions: [session({ inputTextHash: 'ih', inputText: 'x', sentences: [sentence({ recordingHash: 'rh' })] })] });

  const seen = [];
  await transferContent(p, container, {
    getValue: (slot) => (slot.kind === 'inputText' ? 'x' : blobOf([1])),
    onProgress: (p2) => seen.push(p2),
  });

  assert.deepEqual(seen.map((s) => [s.done, s.total, s.direction]), [[1, 2, 'up'], [2, 2, 'up']]);
});

test('publishManifest: writes when the plan says it changed', async () => {
  const container = fakeContainer();
  const p = plan({ sessions: [session()] });
  const result = await publishManifest(p, container);

  assert.equal(result.published, true);
  assert.equal(result.etag, container.etagOf(MANIFEST_PATH));
  assert.deepEqual(container.jsonOf(MANIFEST_PATH), p.manifest);
});

test('publishManifest: writes nothing when the plan says it would be identical', async () => {
  const container = fakeContainer();
  const local = { sessions: [session()] };
  const first = plan(local);
  await publishManifest(first, container);
  const etagAfterFirst = container.etagOf(MANIFEST_PATH);

  const second = plan(local, first.manifest);
  const result = await publishManifest(second, container);

  assert.equal(result.published, false);
  assert.equal(container.etagOf(MANIFEST_PATH), etagAfterFirst, 'the manifest was not rewritten');
});

test('readManifest: an empty container reads as no manifest, not as an error', async () => {
  assert.deepEqual(await readManifest(fakeContainer()), { manifest: null, etag: null, notModified: false });
});

test('readManifest: returns the manifest and its etag', async () => {
  const container = fakeContainer();
  const p = plan({ sessions: [session()] });
  await publishManifest(p, container);

  const result = await readManifest(container);
  assert.deepEqual(result.manifest, p.manifest);
  assert.equal(result.etag, container.etagOf(MANIFEST_PATH));
});

test('readManifest: a matching etag short-circuits instead of re-downloading', async () => {
  const container = fakeContainer();
  await publishManifest(plan({ sessions: [session()] }), container);
  const etag = container.etagOf(MANIFEST_PATH);

  const result = await readManifest(container, etag);
  assert.deepEqual(result, { manifest: null, etag, notModified: true });
});

test('readManifest: a real failure propagates', async () => {
  const container = fakeContainer();
  container.downloadJsonConditional = async () => { throw new Error('HTTP 403'); };
  await assert.rejects(() => readManifest(container), /403/);
});

test('sweepOrphans: deletes content nothing references any more', async () => {
  const container = fakeContainer();
  const withRecording = plan({ sessions: [session({ sentences: [sentence({ recordingHash: 'rh' })] })] });
  await transferContent(withRecording, container, { getValue: () => blobOf([1]) });
  await publishManifest(withRecording, container);

  // The session is gone; its recording is now an orphan.
  const afterDelete = plan({
    sessions: [],
    tombstones: [{ id: 'session:sess1', kind: 'session', targetId: 'sess1', deletedAt: 9999 }],
  }, withRecording.manifest);
  await publishManifest(afterDelete, container);

  const result = await sweepOrphans(afterDelete, container);
  assert.deepEqual(result.deleted, ['recordings/sess1/sent1.wav']);
  assert.equal(result.skipped, false);
});

test('sweepOrphans: never deletes the manifest or the lock', async () => {
  const container = fakeContainer();
  container.seed(MANIFEST_PATH, { version: 6, folders: [], sessions: [], vocab: [], tombstones: [] });
  container.seed('sync.lock', { deviceId: 'x', acquiredAt: 1 });

  const result = await sweepOrphans(plan({}), container);
  assert.deepEqual(result.deleted, []);
  assert.ok(container.has(MANIFEST_PATH));
  assert.ok(container.has('sync.lock'));
});

test('sweepOrphans: spares content another device uploaded during this round', async () => {
  // The race the union with the container's current manifest exists for: this
  // plan was computed before the other device published, so its content looks
  // unreferenced to this plan alone.
  const container = fakeContainer();
  const mine = plan({ sessions: [session({ sentences: [sentence({ recordingHash: 'rh' })] })] });
  await transferContent(mine, container, { getValue: () => blobOf([1]) });

  const theirs = plan({
    sessions: [session({ id: 'sess2', sentences: [sentence({ id: 'sentX', recordingHash: 'rh2' })] })],
  });
  await container.uploadBytes('recordings/sess2/sentX.wav', new Uint8Array([2]), 'audio/wav');
  await publishManifest(theirs, container); // the other device publishes mid-round

  const result = await sweepOrphans(mine, container);

  assert.deepEqual(result.deleted, [], 'nothing swept');
  assert.ok(container.has('recordings/sess2/sentX.wav'), 'the other device\'s fresh upload survived');
  assert.ok(container.has('recordings/sess1/sent1.wav'), 'and so did this device\'s');
});

test('sweepOrphans: a listing failure skips the sweep and says why, rather than failing the sync', async () => {
  const container = fakeContainer();
  container.listBlobs = async () => { throw new Error('HTTP 403 (no list permission)'); };

  const result = await sweepOrphans(plan({}), container);
  assert.deepEqual(result.deleted, []);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /could not list the container.*403/);
});

test('sweepOrphans: a manifest re-read failure skips the sweep rather than deleting against stale data', async () => {
  const container = fakeContainer();
  container.downloadJsonConditional = async () => { throw new Error('HTTP 500'); };

  const result = await sweepOrphans(plan({}), container);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /could not re-read the manifest/);
});

test('sweepOrphans: a delete failure stops and reports what it managed', async () => {
  const container = fakeContainer();
  const withRecording = plan({
    sessions: [session({ sentences: [sentence({ recordingHash: 'a' }), sentence({ id: 'sent2', recordingHash: 'b' })] })],
  });
  await transferContent(withRecording, container, { getValue: () => blobOf([1]) });

  const empty = plan({});
  container.deleteBlob = async () => { throw new Error('HTTP 403 (no delete permission)'); };

  const result = await sweepOrphans(empty, container);
  assert.deepEqual(result.deleted, []);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /stopped after 0/);
});

test('manifestContentPaths: finds every kind of content a manifest references', async () => {
  const p = plan({
    sessions: [session({
      inputTextHash: 'ih', sourceAudioHash: 'sh',
      sentences: [sentence({ recordingHash: 'rh', referenceHash: 'fh', assessmentHash: 'ah' })],
    })],
    vocab: [{ id: 'w', text: 'w', audioPathKey: 'k', createdAt: 1, updatedAt: 1, sources: [{ occurrenceId: 'o', addedAt: 1, audioHash: 'vh' }] }],
  });
  assert.deepEqual(manifestContentPaths(p.manifest).sort(), [
    'assessments/sess1/sent1.json',
    'inputtext/sess1.txt',
    'recordings/sess1/sent1.wav',
    'references/sess1/sent1.audio',
    'sourceaudio/sess1.audio',
    'vocab-audio/k/o.audio',
  ]);
});
