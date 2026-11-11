// Opening the database, including the two outcomes that only exist because a
// person can have the app open in more than one tab. Both were reachable the
// moment the schema gained a version: an upgrade that cannot proceed.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, resetDbForTests, DB_NAME, DB_VERSION, ALL_STORES } from '../../js/db/open.js';

/** A connection at an older version, held open the way another tab holds one. */
const openOld = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, DB_VERSION - 1);
  req.onupgradeneeded = () => { /* an older schema; its stores do not matter here */ };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
  req.onblocked = () => reject(new Error('blocked'));
});

test('an older tab in the way is reported, rather than waited on forever', async () => {
  resetDbForTests();
  const old = await openOld();
  // Deliberately not reacting to versionchange: this stands in for a tab
  // running the previous build, which has no such handler.
  old.onversionchange = () => {};

  await assert.rejects(() => openDb(), /blocked: another tab is still using an older version/);

  old.close();
  resetDbForTests();
});

test('this connection lets go when another tab needs to upgrade', async () => {
  resetDbForTests();
  const db = await openDb();
  assert.deepEqual([...db.objectStoreNames].sort(), [...ALL_STORES].sort());

  // Another tab asking for a newer version: this one must close, so that open
  // is not blocked by us, and the next call here must open again rather than
  // hand out the connection it just closed.
  const newer = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION + 1);
    req.onupgradeneeded = () => { /* nothing to add */ };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('the old connection did not let go'));
  });

  newer.close();
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = resolve;
    req.onerror = resolve;
  });

  // No resetDbForTests here on purpose: that would do the forgetting the
  // module is supposed to have done itself. A cached closed connection would
  // come back as the very same object.
  const again = await openDb();
  assert.notEqual(again, db);
  again.close();
  resetDbForTests();
});

test('a content store keyed by path is dropped and made again keyed by hash: no migration, by rule', async () => {
  // Up to version 3 the content store's key was the blob path. The rule in
  // ARCHITECTURE.md is that a schema change adds or drops stores and nothing
  // else -- the records keep their claims and the next sync fetches the bytes
  // back from the container -- so the old store goes rather than being
  // rewritten, and the sessions beside it are untouched.
  resetDbForTests();
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = resolve;
    req.onerror = resolve;
  });

  const old = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['sessions', 'vocab', 'tombstones']) db.createObjectStore(name, { keyPath: 'id' });
      db.createObjectStore('content', { keyPath: 'path' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const tx = old.transaction(['content', 'sessions'], 'readwrite');
    tx.objectStore('content').put({ path: 'recordings/s1/a.wav', kind: 'recording', hash: 'h-a', value: 'bytes', storedAt: 1 });
    tx.objectStore('sessions').put({ id: 's1', updatedAt: 1, sentences: [{ id: 'a', recordingHash: 'h-a' }] });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  old.close();

  const db = await openDb();
  const read = (store, op) => new Promise((resolve, reject) => {
    const req = db.transaction([store], 'readonly').objectStore(store)[op]();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  assert.equal(db.transaction(['content'], 'readonly').objectStore('content').keyPath, 'hash');
  assert.deepEqual(await read('content', 'getAllKeys'), [], 'the old bytes are gone with the old store');
  assert.deepEqual((await read('sessions', 'getAll'))[0].sentences[0].recordingHash, 'h-a',
    'the record still claims its clip, which is what the next sync fetches back by');

  db.close();
  resetDbForTests();
});
