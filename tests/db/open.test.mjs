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
