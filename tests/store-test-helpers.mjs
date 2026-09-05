// Shared helper for js/store/* tests: db.js caches a single open connection
// per process (module-level `dbPromise`), so every test in one file shares
// the same underlying fake-indexeddb database. This wipes all three object
// stores directly (bypassing tombstone recording, unlike store.clearAll())
// so each test starts from a clean slate regardless of what an earlier test
// in the same file left behind.
import { getStore, wrap, STORE, FOLDERS_STORE, TOMBSTONES_STORE } from '../js/store/db.js';

export async function resetStores() {
  for (const name of [STORE, FOLDERS_STORE, TOMBSTONES_STORE]) {
    const s = await getStore('readwrite', name);
    await wrap(s.clear());
  }
}
