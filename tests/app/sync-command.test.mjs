// A whole sync round against an in-memory container and a real (fake-backed)
// IndexedDB: two devices converging, content moving both ways, deletions
// propagating, and the guards holding when something changes mid-round.
import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { syncNow, eraseCloud } from '../../js/app/commands/sync.js';
import { fakeContainer } from '../cloud/fake-container.mjs';
import * as db from '../../js/db/entities.js';
import { transact, ALL_STORES, request } from '../../js/db/open.js';
import { blankSentence } from '../../js/model/session.js';
import { hashBlob, hashString, materializeBlob } from '../../js/platform/hash.js';
import { MANIFEST_PATH } from '../../js/cloud/sync/run.js';
import { LOCK_PATH } from '../../js/cloud/sync/lock.js';
import { seed } from '../helpers/seed.mjs';

const settings = (deviceId = 'device-a') => ({ deviceId: () => deviceId });

function makeCache() {
  let value = { etag: null, manifest: null };
  return { get: () => value, set: (next) => { value = next; } };
}

const deps = (container, over = {}) => ({
  container,
  db,
  settings: settings(),
  hash: { materializeBlob },
  manifestCache: makeCache(),
  ...over,
});

const clip = (bytes) => new Blob([new Uint8Array(bytes)], { type: 'audio/wav' });

async function wipe() {
  await transact(ALL_STORES, 'readwrite', async (stores) => {
    for (const name of ALL_STORES) await request(stores[name].clear());
  });
}

async function seedSession({ id = 'sess1', text = 'hello', recording = null, inputText = null } = {}) {
  const sentence = blankSentence({ id: `${id}-s1`, text, lang: 'en', now: 10 });
  if (recording) {
    sentence.recording = recording;
    sentence.recordingHash = await hashBlob(recording);
  }
  await seed('sessions', {
    id, name: null, splitMode: 'auto',
    createdAt: 1, updatedAt: 10, metaUpdatedAt: 10,
    inputText, inputTextHash: inputText ? await hashString(inputText) : null,
    sourceAudio: null, sourceAudioHash: null,
    sentences: [sentence],
  });
}

beforeEach(wipe);

test('with no container configured it says so instead of failing', async () => {
  const result = await syncNow({ deps: deps(null) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-configured');
});

test('a first round uploads everything and publishes a manifest', async () => {
  const container = fakeContainer();
  await seedSession({ recording: clip([1, 2, 3]), inputText: 'hello' });

  const result = await syncNow({ deps: deps(container) });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.uploaded, 2, 'the recording and the practice text');
  assert.ok(container.has(MANIFEST_PATH));
  assert.deepEqual([...new Uint8Array(container.bytesOf('recordings/sess1/sess1-s1.wav'))], [1, 2, 3]);
  assert.equal(container.textOf('inputtext/sess1.txt'), 'hello');
});

test('the lock is taken for the round and released at the end', async () => {
  const container = fakeContainer();
  await seedSession();

  await syncNow({ deps: deps(container) });

  assert.equal(container.has(LOCK_PATH), false, 'released');
  const ops = container.calls().map((c) => c.op);
  assert.equal(ops[0], 'uploadBytes', 'the lock is taken before anything is read');
  assert.equal(container.calls().at(-1).op, 'deleteBlob');
});

test('another device holding the lock skips the round without touching anything', async () => {
  const container = fakeContainer();
  container.seed(LOCK_PATH, { deviceId: 'other-device', acquiredAt: Date.now() });
  await seedSession({ recording: clip([1]) });

  const result = await syncNow({ deps: deps(container) });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'locked-by:other-device');
  assert.equal(container.has(MANIFEST_PATH), false, 'nothing was published');
  assert.deepEqual(container.jsonOf(LOCK_PATH).deviceId, 'other-device', 'and their lock is intact');
});

test('a second device pulls the session down, with its content', async () => {
  const container = fakeContainer();
  await seedSession({ recording: clip([4, 5, 6]), inputText: 'shared text' });
  await syncNow({ deps: deps(container) });

  // A different browser: same container, empty database.
  await wipe();
  const result = await syncNow({ deps: deps(container) });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.downloaded, 2);
  assert.equal(result.written, 1);

  const [session] = await db.listAll('sessions');
  assert.equal(session.id, 'sess1');
  assert.equal(session.inputText, 'shared text');
  assert.deepEqual([...new Uint8Array(await session.sentences[0].recording.arrayBuffer())], [4, 5, 6]);
});

test('an unchanged second round transfers nothing and does not rewrite the manifest', async () => {
  const container = fakeContainer();
  await seedSession({ recording: clip([7]) });

  const cache = makeCache();
  await syncNow({ deps: deps(container, { manifestCache: cache }) });
  const etagAfterFirst = container.etagOf(MANIFEST_PATH);

  const result = await syncNow({ deps: deps(container, { manifestCache: cache }) });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.uploaded, 0);
  assert.equal(result.downloaded, 0);
  assert.equal(container.etagOf(MANIFEST_PATH), etagAfterFirst);
});

test('the cached manifest etag turns the next read into a not-modified check', async () => {
  const container = fakeContainer();
  await seedSession();
  const cache = makeCache();

  await syncNow({ deps: deps(container, { manifestCache: cache }) });
  await syncNow({ deps: deps(container, { manifestCache: cache }) });

  // Not the last read: the orphan sweep deliberately re-reads the manifest
  // unconditionally at the end of every round, so the last call always carries
  // no etag.
  const reads = container.callsOf('downloadJsonConditional').filter((c) => c.path === MANIFEST_PATH);
  assert.ok(reads.some((r) => r.knownEtag), 'the second round asked conditionally');
});

test('a deletion here propagates, and the other device applies it', async () => {
  const container = fakeContainer();
  await seedSession({ recording: clip([1]) });
  await syncNow({ deps: deps(container) });

  await db.remove('sessions', 'sess1');
  const result = await syncNow({ deps: deps(container) });

  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(container.jsonOf(MANIFEST_PATH).sessions, []);
  assert.ok(container.jsonOf(MANIFEST_PATH).tombstones.some((t) => t.targetId === 'sess1'));

  // The other device, which still has its copy.
  await wipe();
  await seedSession({ recording: clip([1]) });
  const second = await syncNow({ deps: deps(container) });

  assert.equal(second.deleted, 1);
  assert.deepEqual(await db.listAll('sessions'), []);
});

test('content belonging to a deleted session is swept from the container', async () => {
  const container = fakeContainer();
  await seedSession({ recording: clip([1]) });
  await syncNow({ deps: deps(container) });
  assert.ok(container.has('recordings/sess1/sess1-s1.wav'));

  await db.remove('sessions', 'sess1');
  const result = await syncNow({ deps: deps(container) });

  assert.equal(result.swept, 1);
  assert.equal(container.has('recordings/sess1/sess1-s1.wav'), false);
});

test('a record written locally while the round was in flight is not overwritten by it', async () => {
  // The guard that used to be written per entity kind, and was missing from the
  // kind added last. Device A published; device B is pulling, and the user
  // touches that same session while the download is in flight.
  const container = fakeContainer();
  await seedSession({ recording: clip([1]) });
  await syncNow({ deps: deps(container) });

  await wipe(); // device B: nothing local, so the round is a download

  container.downloadBytes = async (path) => {
    // Lands between the plan being computed and its writes being applied.
    await seed('sessions', {
      id: 'sess1', name: 'created here while syncing', splitMode: 'auto',
      createdAt: 1, updatedAt: 9999, metaUpdatedAt: 9999,
      inputText: null, inputTextHash: null, sourceAudio: null, sourceAudioHash: null,
      sentences: [],
    });
    return new Blob([container.bytesOf(path)]);
  };

  const result = await syncNow({ deps: deps(container) });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.written, 0);
  assert.equal(result.skipped, 1, 'the write was refused rather than clobbering');
  assert.equal((await db.getOne('sessions', 'sess1')).name, 'created here while syncing');

  // And the bytes it downloaded for that record did not land either: there is
  // no record reaching them, so they would be unreachable -- and the sweep at
  // the end of the round would delete them anyway. The next round fetches them
  // with the write that was refused.
  assert.deepEqual(await db.listContentPaths(), [], 'no bytes without a record to reach them');
});

test('vocab from two devices unions rather than one overwriting the other', async () => {
  const container = fakeContainer();
  await seed('vocab', {
    id: 'word', text: 'word', lang: 'en', audioPathKey: 'k1', createdAt: 1, updatedAt: 100,
    sources: [{ occurrenceId: 'occ-a', sessionId: 's1', sentenceId: 'x', sentenceTextSnapshot: 'from A', addedAt: 100, audio: null, audioHash: null }],
  });
  await syncNow({ deps: deps(container) });

  await wipe();
  await seed('vocab', {
    id: 'word', text: 'word', lang: 'en', audioPathKey: 'k1', createdAt: 1, updatedAt: 200,
    sources: [{ occurrenceId: 'occ-b', sessionId: 's2', sentenceId: 'y', sentenceTextSnapshot: 'from B', addedAt: 200, audio: null, audioHash: null }],
  });
  const result = await syncNow({ deps: deps(container) });

  assert.equal(result.ok, true, result.reason);
  const [entry] = await db.listAll('vocab');
  assert.deepEqual(entry.sources.map((s) => s.occurrenceId).sort(), ['occ-a', 'occ-b']);
});

test('vocab occurrence audio moves both ways', async () => {
  const container = fakeContainer();
  const audio = clip([9, 9, 9]);
  await seed('vocab', {
    id: 'word', text: 'word', lang: 'en', audioPathKey: 'k1', createdAt: 1, updatedAt: 100,
    sources: [{ occurrenceId: 'occ-a', sessionId: null, sentenceId: null, sentenceTextSnapshot: null, addedAt: 100, audio, audioHash: await hashBlob(audio) }],
  });
  await syncNow({ deps: deps(container) });
  assert.ok(container.has('vocab-audio/k1/occ-a.audio'));

  await wipe();
  await syncNow({ deps: deps(container) });

  const [entry] = await db.listAll('vocab');
  assert.deepEqual([...new Uint8Array(await entry.sources[0].audio.arrayBuffer())], [9, 9, 9]);
});

test('a failure mid-round is reported, and the lock is still released', async () => {
  const container = fakeContainer();
  await seedSession({ recording: clip([1]) });
  container.uploadBytes = async (path, ...rest) => {
    if (path === LOCK_PATH) return fakeContainer().uploadBytes(path, ...rest);
    throw new Error('HTTP 403 (no write permission)');
  };

  const result = await syncNow({ deps: deps(container) });

  assert.equal(result.ok, false);
  assert.match(result.reason, /403/);
  assert.equal(container.has(LOCK_PATH), false, 'the lock did not outlive the failed round');
});

test('content the container cannot supply is warned about, and the round still completes', async () => {
  const container = fakeContainer();
  await seedSession({ recording: clip([1]) });
  await syncNow({ deps: deps(container) });

  await wipe();
  await container.deleteBlob('recordings/sess1/sess1-s1.wav'); // lost from the container

  const result = await syncNow({ deps: deps(container) });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.written, 1, 'the session still arrived');
  assert.ok(result.warnings.some((w) => w.includes('recordings/sess1/sess1-s1.wav')));

  const [session] = await db.listAll('sessions');
  assert.equal(session.sentences[0].recording, null, 'it holds no clip it does not have');
  // The hash is KEPT on purpose. It is the manifest's claim that this recording
  // exists, and another device may still hold the bytes -- clearing it here
  // would publish "there is no recording" and lose the reference for everyone.
  // Keeping it means the next round asks again.
  assert.ok(session.sentences[0].recordingHash, 'but the reference survives for the next round');
});

// ---- Clearing the cloud copy ----

test('eraseCloud: empties the container and leaves this device alone', async () => {
  await wipe();
  await seedSession({ recording: clip([1, 2, 3]) });
  const container = fakeContainer();
  const cache = makeCache();

  await syncNow({ deps: deps(container, { manifestCache: cache }) });
  assert.ok((await container.listBlobs('')).length > 1, 'there is something up there to clear');

  const outcome = await eraseCloud({ deps: deps(container, { manifestCache: cache }) });

  assert.equal(outcome.ok, true);
  assert.ok(outcome.deleted >= 2);
  assert.deepEqual((await container.listBlobs('')).filter((path) => path !== LOCK_PATH), []);
  assert.equal((await db.listAll('sessions')).length, 1, 'the practice is still here');
});

test('eraseCloud: the cached manifest goes with it, so the next round starts fresh', async () => {
  await wipe();
  await seedSession({ recording: clip([4]) });
  const container = fakeContainer();
  const cache = makeCache();

  await syncNow({ deps: deps(container, { manifestCache: cache }) });
  assert.ok(cache.get().manifest, 'the round cached what it published');

  await eraseCloud({ deps: deps(container, { manifestCache: cache }) });
  assert.deepEqual(cache.get(), { etag: null, manifest: null });
});

test('eraseCloud: the next sync uploads this device s copy again', async () => {
  await wipe();
  await seedSession({ recording: clip([5, 6]) });
  const container = fakeContainer();
  const cache = makeCache();

  await syncNow({ deps: deps(container, { manifestCache: cache }) });
  await eraseCloud({ deps: deps(container, { manifestCache: cache }) });

  const second = await syncNow({ deps: deps(container, { manifestCache: cache }) });

  assert.equal(second.ok, true);
  assert.ok(second.uploaded > 0, 'it found nothing there and put it all back');
  assert.ok((await container.listBlobs('')).includes(MANIFEST_PATH));
});

test('content is read at the moment it is uploaded, not when the snapshot was taken', async () => {
  await wipe();
  await seedSession({ recording: clip([5, 6]) });
  const container = fakeContainer();
  const seen = [];

  await syncNow({
    deps: deps(container, {
      hash: { materializeBlob: async (blob) => { seen.push(blob.size); return materializeBlob(blob); } },
    }),
  });

  // Once: on its way up to the container. The round does not write this clip
  // back, because it already holds it -- the record is rewritten, the bytes
  // are not.
  assert.deepEqual(seen, [2]);
});

const dead = (message = 'The object can not be found here') => ({
  materializeBlob: async () => { throw new Error(message); },
});

test('content that could not be read is withheld from the manifest, not dropped from the record', async () => {
  await wipe();
  await seedSession({ recording: clip([5, 6]) });
  const container = fakeContainer();

  const outcome = await syncNow({ deps: deps(container, { hash: dead() }) });

  assert.equal(outcome.ok, true, 'the round finishes: one unreadable clip is not a sync failure');
  assert.equal(outcome.uploaded, 0);
  assert.match(outcome.warnings.join("\n"), /recordings\/sess1\/sess1-s1\.wav: the local copy could not be read \(The object can not be found here\); it stays out of the cloud copy/);
  assert.equal(outcome.warnings.length, 1, 'and it is said once, not twice');

  // The container claims only what it has.
  const manifest = await container.downloadJson(MANIFEST_PATH);
  assert.equal(manifest.sessions[0].sentences[0].recordingHash, null);

  // The record is untouched: nothing is discarded on the strength of one
  // failed read, so the user still decides what happens to that clip.
  const stored = await db.getOne('sessions', 'sess1');
  assert.equal(stored.sentences[0].recordingHash, await hashBlob(clip([5, 6])));
  assert.ok(stored.sentences[0].recording, 'the Blob is still on the record');
});

test('a withheld upload is offered again on the next round', async () => {
  await wipe();
  await seedSession({ recording: clip([5, 6]) });
  const container = fakeContainer();
  const cache = makeCache();

  await syncNow({ deps: deps(container, { hash: dead(), manifestCache: cache }) });
  // Whatever went wrong with the read has passed.
  const second = await syncNow({ deps: deps(container, { manifestCache: cache }) });

  assert.equal(second.ok, true);
  assert.equal(second.uploaded, 1, 'the container never claimed it, so it is still due');
  assert.deepEqual([...new Uint8Array(container.bytesOf('recordings/sess1/sess1-s1.wav'))], [5, 6]);
  assert.deepEqual(second.warnings, []);
});

test('withholding one slot leaves the rest of the round alone', async () => {
  await wipe();
  await seedSession({ recording: clip([5, 6]), inputText: 'hello there' });
  const container = fakeContainer();

  const outcome = await syncNow({ deps: deps(container, { hash: dead() }) });

  assert.equal(outcome.ok, true);
  // The practice text is a string, not a Blob, so it is unaffected.
  assert.equal(container.textOf('inputtext/sess1.txt'), 'hello there');
  const manifest = await container.downloadJson(MANIFEST_PATH);
  assert.ok(manifest.sessions[0].inputTextHash, 'and the manifest still claims it');
});

test('eraseCloud: refuses while another device holds the lock', async () => {
  const container = fakeContainer();
  await container.uploadJson(LOCK_PATH, { deviceId: 'device-b', acquiredAt: Date.now() });
  await container.uploadJson(MANIFEST_PATH, { version: 6 });

  const outcome = await eraseCloud({ deps: deps(container) });

  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /locked-by:device-b/);
  assert.ok((await container.listBlobs('')).includes(MANIFEST_PATH), 'and nothing was deleted');
});

test('eraseCloud: with no container configured it says so', async () => {
  assert.deepEqual(
    await eraseCloud({ deps: deps(null) }),
    { ok: false, reason: 'not-configured', deleted: 0 },
  );
});

test('eraseCloud: releases the lock afterwards, so the next round is not blocked', async () => {
  await wipe();
  await seedSession();
  const container = fakeContainer();

  await eraseCloud({ deps: deps(container) });
  const after = await syncNow({ deps: deps(container) });

  assert.equal(after.ok, true);
});

test('an upload that fails stops the round before anything is published', async () => {
  // The invariant the whole content plan rests on: the container never carries
  // a manifest naming bytes it does not have. A failed upload is not withheld
  // and carried on from -- it ends the round, so the next one plans against a
  // container that has not moved.
  await seedSession({ recording: clip([1, 2]), inputText: 'text too' });
  const container = fakeContainer();
  const realUpload = container.uploadBytes;
  container.uploadBytes = async (path, ...rest) => {
    if (path.startsWith('recordings/')) throw new Error('Upload of "recordings/..." failed: HTTP 403');
    return realUpload(path, ...rest);
  };

  const result = await syncNow({ deps: deps(container) });

  assert.equal(result.ok, false);
  assert.match(result.reason, /HTTP 403/);
  assert.equal(container.has(MANIFEST_PATH), false, 'nothing was published');
  assert.equal(container.has(LOCK_PATH), false, 'and the lock was still released');

  // The local side is untouched, so the next round offers the same work again.
  const stored = await db.getOne('sessions', 'sess1');
  assert.equal(stored.sentences[0].recordingHash, await hashBlob(clip([1, 2])));
});

test('the round keeps its order: lock, read, upload, publish, write, sweep, release', async () => {
  // Publishing before writing locally means a failure in between leaves the
  // container ahead of this device, which the next round simply pulls. The
  // reverse leaves content referenced by nothing, so the order is load-bearing
  // rather than tidy.
  await seedSession({ recording: clip([5]) });
  const container = fakeContainer();
  const log = [];
  const traced = {
    ...container,
    uploadJson: async (path, value, opts) => { log.push(`put ${path}`); return container.uploadJson(path, value, opts); },
    uploadBytes: async (path, ...rest) => { log.push(`put ${path}`); return container.uploadBytes(path, ...rest); },
    downloadJsonConditional: async (path, etag) => { log.push(`get ${path}`); return container.downloadJsonConditional(path, etag); },
    listBlobs: async (prefix) => { log.push('list'); return container.listBlobs(prefix); },
    deleteBlob: async (path, opts) => { log.push(`delete ${path}`); return container.deleteBlob(path, opts); },
  };
  const tracedDb = { ...db, applyPlan: async (...args) => { log.push('write locally'); return db.applyPlan(...args); } };

  const result = await syncNow({ deps: deps(traced, { db: tracedDb }) });
  assert.equal(result.ok, true, result.reason);

  const steps = log.filter((step) => step !== 'list' && !step.startsWith('get manifest'));
  assert.deepEqual(steps, [
    `put ${LOCK_PATH}`,
    'put recordings/sess1/sess1-s1.wav',
    `put ${MANIFEST_PATH}`,
    'write locally',
    `delete ${LOCK_PATH}`,
  ]);
  assert.equal(log[1], `get ${MANIFEST_PATH}`, 'the manifest is read once the lock is held');
});
