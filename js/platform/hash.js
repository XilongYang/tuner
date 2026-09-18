// Content hashing, and the one Blob quirk this app has to work around.
//
// Both are platform facts rather than domain rules: they depend on Web Crypto
// and on how browsers hand Blobs back out of IndexedDB. (In the previous
// implementation the Blob helper lived in a module called `hashing.js`, which
// is why two call sites hand-wrote their own copy instead of finding it.)

/** SHA-256 as lowercase hex. */
async function digestHex(bufferSource) {
  const digest = await crypto.subtle.digest('SHA-256', bufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Content hash of a Blob.
 *
 * Content is addressed by hash throughout: it is what tells sync whether it
 * already holds a given recording, and it is the only reliable "did this
 * change" signal available, since `rewrapBlob` below replaces the Blob
 * instance on every save and so object identity means nothing here.
 */
export async function hashBlob(blob) {
  return digestHex(await blob.arrayBuffer());
}

/** Content hash of a string: practice text, and serialized assessment results. */
export async function hashString(text) {
  return digestHex(new TextEncoder().encode(text));
}

/** Content hash of a JSON-serializable value, hashed as the exact text that will be stored. */
export async function hashJson(value) {
  return hashString(JSON.stringify(value));
}

/**
 * Wrap a Blob read out of IndexedDB in a fresh in-memory Blob before storing it
 * again.
 *
 * Chromium fails with "Error preparing Blob/File data to be stored in object
 * store" when a Blob that came out of one transaction is written back in a
 * different one. Rewrapping costs nothing (no bytes are read eagerly) and is a
 * no-op for a Blob that was never stored.
 *
 * Note this defers reading rather than forcing it, so it does not protect a
 * Blob held across a long gap -- a sync that keeps one across its network
 * round-trip must materialize the bytes instead (see `materializeBlob`).
 */
export function rewrapBlob(blob) {
  return blob ? new Blob([blob], { type: blob.type }) : blob;
}

/**
 * Read a Blob's bytes now and return a self-contained copy.
 *
 * Needed wherever a Blob has to survive something slow: the backing resource a
 * Blob from IndexedDB refers to can be gone by the time a sync finishes its
 * uploads and tries to store it, and `rewrapBlob`'s deferred read is not enough
 * there because it never actually reads until the store.
 */
export async function materializeBlob(blob) {
  if (!blob) return blob;
  return new Blob([await blob.arrayBuffer()], { type: blob.type });
}
