import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eraseContainer } from '../../js/cloud/sync/erase.js';
import { LOCK_PATH } from '../../js/cloud/sync/lock.js';
import { fakeContainer } from './fake-container.mjs';

const seeded = async () => {
  const container = fakeContainer();
  await container.uploadJson('manifest.json', { version: 6 });
  await container.uploadBytes('references/sess1/s1.audio', new Uint8Array([1]), 'audio/wav');
  await container.uploadBytes('recordings/sess1/s1.wav', new Uint8Array([2]), 'audio/wav');
  await container.uploadJson(LOCK_PATH, { deviceId: 'other' });
  return container;
};

test('eraseContainer: deletes everything it finds', async () => {
  const container = await seeded();

  const result = await eraseContainer(container);

  assert.deepEqual(result.deleted.sort(), ['manifest.json', 'recordings/sess1/s1.wav', 'references/sess1/s1.audio']);
  assert.equal(result.reason, null);
  assert.deepEqual(await container.listBlobs(''), [LOCK_PATH]);
});

test('eraseContainer: leaves the lock alone -- it is how devices take turns, not data', async () => {
  const container = await seeded();
  await eraseContainer(container);
  assert.deepEqual(await container.listBlobs(''), [LOCK_PATH]);
});

test('eraseContainer: reports progress as it goes', async () => {
  const container = await seeded();
  const seen = [];

  await eraseContainer(container, { onProgress: (progress) => seen.push(progress.done) });

  assert.deepEqual(seen, [1, 2, 3]);
});

test('eraseContainer: an empty container is not an error', async () => {
  const result = await eraseContainer(fakeContainer());
  assert.deepEqual(result, { deleted: [], failed: null, reason: null });
});

test('eraseContainer: stops at the first failure and says what it managed', async () => {
  const container = await seeded();
  const realDelete = container.deleteBlob;
  let calls = 0;
  container.deleteBlob = async (path) => {
    calls += 1;
    if (calls === 2) throw new Error('HTTP 403');
    return realDelete(path);
  };

  const result = await eraseContainer(container);

  assert.equal(result.deleted.length, 1);
  assert.match(result.reason, /stopped after 1: HTTP 403/);
  assert.ok(result.failed, 'and names the blob it stopped on');
});

test('eraseContainer: a container it cannot even list is reported, not thrown', async () => {
  const container = fakeContainer();
  container.listBlobs = async () => { throw new Error('HTTP 403'); };

  const result = await eraseContainer(container);

  assert.deepEqual(result.deleted, []);
  assert.match(result.reason, /could not list the container/);
});
