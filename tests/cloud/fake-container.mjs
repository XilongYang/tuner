// An in-memory stand-in for cloud/blob.js's `container()`, implementing the
// same seven methods.
//
// Everything built on the container -- the lock, the plan runner, the sync
// command -- takes one as an argument, so its tests pass this instead of
// patching the module registry. That is why the suite needs no module mocking
// and no experimental Node flag: a previous version of this codebase relied on
// `mock.module`, and an import-hoisting subtlety once made the mock silently
// not apply, leaving tests that "passed" while talking to the real network.
//
// Modelled faithfully where behaviour is branched on -- `.notFound`,
// `.conflict`, ETag preconditions, the 304 short-circuit, delete-is-idempotent
// -- and deliberately not modelled where it is not: no HTTP, no headers, no
// XML, no timeouts. Those belong to cloud/blob.js and are tested there against
// a stubbed fetch.

export function fakeContainer() {
  /** @type {Map<string, {bytes: Uint8Array, contentType: string, etag: string}>} */
  const blobs = new Map();
  let nextEtag = 1;
  const calls = [];

  const notFound = (path) => {
    const err = new Error(`Download of "${path}": not found`);
    err.notFound = true;
    return err;
  };
  const conflict = (path) => {
    const err = new Error(`Write to "${path}": conflict (changed since last read)`);
    err.conflict = true;
    return err;
  };

  const toBytes = async (data) => {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof data?.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer());
    return new TextEncoder().encode(String(data));
  };

  async function uploadBytes(path, data, contentType = 'application/octet-stream', opts = {}) {
    calls.push({ op: 'uploadBytes', path, opts });
    const existing = blobs.get(path);
    if (opts.ifNoneMatch === '*' && existing) throw conflict(path);
    if (opts.ifMatch && (!existing || existing.etag !== opts.ifMatch)) throw conflict(path);
    const etag = `"e${nextEtag++}"`;
    blobs.set(path, { bytes: await toBytes(data), contentType, etag });
    return etag;
  }

  async function downloadBytes(path) {
    calls.push({ op: 'downloadBytes', path });
    const blob = blobs.get(path);
    if (!blob) throw notFound(path);
    return new Blob([blob.bytes], { type: blob.contentType });
  }

  async function downloadJsonConditional(path, knownEtag) {
    calls.push({ op: 'downloadJsonConditional', path, knownEtag });
    const blob = blobs.get(path);
    if (!blob) throw notFound(path);
    if (knownEtag && knownEtag === blob.etag) return { notModified: true };
    return { notModified: false, value: JSON.parse(new TextDecoder().decode(blob.bytes)), etag: blob.etag };
  }

  async function deleteBlob(path, opts = {}) {
    calls.push({ op: 'deleteBlob', path, opts });
    const existing = blobs.get(path);
    if (!existing) return; // already gone counts as success, as in the real one
    if (opts.ifMatch && existing.etag !== opts.ifMatch) throw conflict(path);
    blobs.delete(path);
  }

  // Composed methods dispatch through `api` rather than closing over the
  // functions above, so a test that replaces one method intercepts every
  // method built on it -- `uploadJson` really does go through `uploadBytes`.
  // Closing over them instead silently ignores such an override, which makes a
  // test look like it exercises a failure path when it exercises nothing.
  const api = {
    // The Container interface.
    uploadBytes,
    uploadJson: (path, value, opts) => api.uploadBytes(path, new TextEncoder().encode(JSON.stringify(value)), 'application/json', opts),
    downloadBytes,
    downloadJson: async (path) => {
      const blob = blobs.get(path);
      if (!blob) throw notFound(path);
      return JSON.parse(new TextDecoder().decode(blob.bytes));
    },
    downloadJsonConditional,
    listBlobs: async (prefix = '') => {
      calls.push({ op: 'listBlobs', prefix });
      return [...blobs.keys()].filter((p) => p.startsWith(prefix)).sort();
    },
    deleteBlob,

    // Test-only inspection.
    paths: () => [...blobs.keys()].sort(),
    has: (path) => blobs.has(path),
    etagOf: (path) => blobs.get(path)?.etag ?? null,
    bytesOf: (path) => blobs.get(path)?.bytes ?? null,
    textOf: (path) => (blobs.has(path) ? new TextDecoder().decode(blobs.get(path).bytes) : null),
    jsonOf: (path) => (blobs.has(path) ? JSON.parse(new TextDecoder().decode(blobs.get(path).bytes)) : null),
    seed: (path, value, contentType = 'application/json') => {
      blobs.set(path, {
        bytes: typeof value === 'string' || value instanceof Uint8Array
          ? (value instanceof Uint8Array ? value : new TextEncoder().encode(value))
          : new TextEncoder().encode(JSON.stringify(value)),
        contentType,
        etag: `"e${nextEtag++}"`,
      });
    },
    calls: () => calls,
    callsOf: (op) => calls.filter((c) => c.op === op),
  };
  return api;
}
