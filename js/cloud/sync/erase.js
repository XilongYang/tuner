// Emptying the container.
//
// Deliberately separate from the sync round: a sync reconciles two sides, and
// this discards one of them outright. Keeping it apart means no path through
// planSync() can ever delete everything, whatever it is handed.
//
// The lock is left alone. It is not this app's data -- it is how devices take
// turns -- and deleting one another device is holding would let two of them
// write at once. A caller takes the lock first, exactly as a sync does, so
// nothing is being written while this runs.

import { LOCK_PATH } from './lock.js';

const noop = () => {};

/**
 * Delete everything in the container except the lock.
 *
 * Lists rather than working from the manifest: the point of this is to leave
 * nothing behind, including blobs the manifest has already lost track of, which
 * is usually the reason for reaching for it in the first place.
 *
 * Stops at the first failure and reports what it managed, rather than carrying
 * on and reporting a success it did not have. A container half emptied is still
 * emptier than it was, and running it again is safe.
 *
 * @returns {Promise<{deleted: string[], failed: string|null, reason: string|null}>}
 */
export async function eraseContainer(container, { onProgress = noop } = {}) {
  let paths;
  try {
    paths = (await container.listBlobs('')).filter((path) => path !== LOCK_PATH);
  } catch (err) {
    return { deleted: [], failed: null, reason: `could not list the container: ${err.message}` };
  }

  const deleted = [];
  for (const path of paths) {
    try {
      await container.deleteBlob(path);
    } catch (err) {
      return { deleted, failed: path, reason: `stopped after ${deleted.length}: ${err.message}` };
    }
    deleted.push(path);
    onProgress({ done: deleted.length, total: paths.length, path });
  }

  return { deleted, failed: null, reason: null };
}
