// A fake in-memory implementation of js/azure-blob.js's exported API, for
// unit-testing sync/azure-sync.js and sync/restore.js without a real Azure
// account or network access. Swapped in for the real module via Node's
// mock.module() (see tests/azure-sync.test.mjs/tests/restore.test.mjs) --
// every consumer that imports '../azure-blob.js' (azure-sync.js, restore.js,
// sync/lock.js, sync/blob-paths.js's cleanupOrphanBlobs()) resolves to the
// same mocked module instance, so mocking it once in a test file covers the
// whole sync stack that test exercises.
//
// Mirrors the REAL module's OBSERVABLE behavior that the sync code actually
// branches on: a missing blob throws a `.notFound`-tagged error; a failed
// If-None-Match/If-Match precondition throws a `.conflict`-tagged error;
// downloadJsonConditional short-circuits to `{ notModified: true }` when the
// caller's ETag still matches. Deliberately NOT a byte-for-byte
// reimplementation of azure-blob.js's HTTP-level details (request headers,
// XML list-blobs response parsing, timeouts) -- those belong to azure-blob.js
// itself, not to a fake standing in for it.

let blobs = new Map(); // path -> { bytes: Uint8Array, contentType, etag }
let nextEtagSeq = 1;

/** Wipe the fake container back to empty -- call this in beforeEach. */
export function resetFakeAzure() {
  blobs = new Map();
  nextEtagSeq = 1;
}

/** Read-only peek at the fake container's current contents, for assertions
 *  (e.g. "was this path uploaded", "is this path gone after cleanup"). */
export function fakeAzureBlobs() {
  return blobs;
}

function newEtag() {
  return `"etag-${nextEtagSeq++}"`;
}

function notFoundError(action) {
  const err = new Error(`${action}: not found`);
  err.notFound = true;
  return err;
}

function conflictError(action) {
  const err = new Error(`${action}: conflict (changed since last read)`);
  err.conflict = true;
  return err;
}

async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  throw new Error('fake-azure-blob: unsupported upload data type');
}

export async function uploadBytes(sasUrl, path, data, contentType = 'application/octet-stream', opts = {}) {
  const existing = blobs.get(path);
  if (opts.ifNoneMatch === '*' && existing) throw conflictError(`Upload of "${path}"`);
  if (opts.ifMatch && (!existing || existing.etag !== opts.ifMatch)) throw conflictError(`Upload of "${path}"`);
  const etag = newEtag();
  blobs.set(path, { bytes: await toBytes(data), contentType, etag });
  return etag;
}

export function uploadJson(sasUrl, path, value, opts) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return uploadBytes(sasUrl, path, bytes, 'application/json', opts);
}

export async function downloadBytes(sasUrl, path) {
  const entry = blobs.get(path);
  if (!entry) throw notFoundError(`Download of "${path}"`);
  return new Blob([entry.bytes], { type: entry.contentType });
}

export async function downloadJson(sasUrl, path) {
  const blob = await downloadBytes(sasUrl, path);
  return JSON.parse(await blob.text());
}

export async function downloadJsonConditional(sasUrl, path, knownEtag) {
  const entry = blobs.get(path);
  if (!entry) throw notFoundError(`Download of "${path}"`);
  if (knownEtag && entry.etag === knownEtag) return { notModified: true };
  const value = JSON.parse(new TextDecoder().decode(entry.bytes));
  return { notModified: false, value, etag: entry.etag };
}

export async function listBlobs(sasUrl, prefix) {
  const names = [];
  for (const path of blobs.keys()) {
    if (!prefix || path.startsWith(prefix)) names.push(path);
  }
  return names;
}

export async function deleteBlob(sasUrl, path, opts = {}) {
  const entry = blobs.get(path);
  if (!entry) return; // already gone -- same "treat 404 as success" as the real module
  if (opts.ifMatch && entry.etag !== opts.ifMatch) throw conflictError(`Delete of "${path}"`);
  blobs.delete(path);
}
