// Content hashing, and reading a Blob's bytes into a value that owns them.
//
// Both are platform facts rather than domain rules: they depend on Web Crypto
// and on how browsers hand Blobs back out of IndexedDB.

/** SHA-256 as lowercase hex. */
async function digestHex(bufferSource) {
  const digest = await crypto.subtle.digest('SHA-256', bufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Content hash of a Blob.
 *
 * Content is addressed by hash throughout: it is what tells sync whether it
 * already holds a given recording, what tells the store whether these bytes
 * are ones it has written before, and the only "did this change" signal that
 * does not depend on who happens to hold which object.
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
 * Read a Blob's bytes now and return a self-contained copy.
 *
 * A Blob is a reference to bytes that live somewhere the page does not own --
 * a fetch response, a file on disk, the database itself -- and that reference
 * can stop resolving. Anything that has to survive being stored, or being
 * carried across a network round-trip, is read into a copy of its own first.
 *
 * This is the only way bytes enter the content store, and the reason nothing
 * there is a reference to somewhere else.
 */
export async function materializeBlob(blob) {
  if (!blob) return blob;
  return new Blob([await blob.arrayBuffer()], { type: blob.type });
}
