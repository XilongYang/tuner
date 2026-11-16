// A zip file, written and read -- stored entries only, no compression.
//
// The archive an export produces is mostly audio, which is already compressed,
// so deflating it would cost time for nothing. That is also what lets this stay
// small: no codec, no dependency, and an entry's bytes are read straight back
// out of the file.
//
// Written as a Blob built from parts rather than one buffer, so a library of
// recordings is not copied into a second, contiguous allocation to be saved.
// Each entry's bytes are read once, to checksum them, and then let go.
//
// Limits are the classic format's and are refused rather than worked around:
// 65 535 entries and 4 GiB. Past either, `zip64` would be needed, and a file
// that silently wraps is worse than one that says it cannot be made.

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const UTF8_NAMES = 0x0800;
const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Fixed-size little-endian fields, written by position. */
function header(size, fields) {
  const view = new DataView(new ArrayBuffer(size));
  for (const [offset, width, value] of fields) {
    if (width === 2) view.setUint16(offset, value, true);
    else view.setUint32(offset, value, true);
  }
  return view.buffer;
}

/**
 * @param {Array<{name: string, data: Blob|Uint8Array}>} entries
 * @param {string} [type]
 * @returns {Promise<Blob>}
 */
export async function writeZip(entries, type = 'application/zip') {
  if (entries.length > MAX_ENTRIES) throw new Error(`A zip file holds at most ${MAX_ENTRIES} files; this has ${entries.length}`);

  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = encoder.encode(name);
    const blob = data instanceof Blob ? data : new Blob([data]);
    const size = blob.size;
    const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
    if (size > MAX_BYTES || offset > MAX_BYTES) throw new Error('A zip file cannot hold more than 4 GiB');

    const local = header(30, [
      [0, 4, LOCAL_SIGNATURE], [4, 2, 20], [6, 2, UTF8_NAMES], [8, 2, 0],
      [14, 4, crc], [18, 4, size], [22, 4, size], [26, 2, nameBytes.length],
    ]);
    parts.push(local, nameBytes, blob);

    central.push(header(46, [
      [0, 4, CENTRAL_SIGNATURE], [4, 2, 20], [6, 2, 20], [8, 2, UTF8_NAMES], [10, 2, 0],
      [16, 4, crc], [20, 4, size], [24, 4, size], [28, 2, nameBytes.length],
      [42, 4, offset],
    ]), nameBytes);

    offset += 30 + nameBytes.length + size;
  }

  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  if (offset + centralSize > MAX_BYTES) throw new Error('A zip file cannot hold more than 4 GiB');
  const end = header(22, [
    [0, 4, END_SIGNATURE], [8, 2, entries.length], [10, 2, entries.length],
    [12, 4, centralSize], [16, 4, offset],
  ]);
  return new Blob([...parts, ...central, end], { type });
}

/**
 * Every entry of a zip file, as Blobs sliced from it (so nothing is copied).
 *
 * Throws on anything that is not a stored-entry zip this module could have
 * written, and on an entry whose bytes do not match their checksum -- a
 * truncated download is told apart from a good archive here, not later as a
 * clip that will not play.
 *
 * @param {Blob} file
 * @returns {Promise<Map<string, Blob>>}
 */
export async function readZip(file) {
  // The end record sits in the last 22 bytes plus an optional comment of up to
  // 64 KiB, so that tail is all that has to be searched.
  const tailSize = Math.min(file.size, 22 + 0xffff);
  const tail = new DataView(await file.slice(file.size - tailSize).arrayBuffer());
  let end = -1;
  for (let i = tailSize - 22; i >= 0; i -= 1) {
    if (tail.getUint32(i, true) === END_SIGNATURE) { end = i; break; }
  }
  if (end < 0) throw new Error('This is not a zip file');

  const count = tail.getUint16(end + 10, true);
  const centralSize = tail.getUint32(end + 12, true);
  const centralOffset = tail.getUint32(end + 16, true);
  if (centralOffset + centralSize > file.size) throw new Error('This zip file is cut short');

  const directory = new DataView(await file.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
  const decoder = new TextDecoder();
  const entries = new Map();
  let at = 0;

  for (let n = 0; n < count; n += 1) {
    if (at + 46 > directory.byteLength || directory.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new Error('This zip file\'s directory is damaged');
    }
    const method = directory.getUint16(at + 10, true);
    const crc = directory.getUint32(at + 16, true);
    const size = directory.getUint32(at + 20, true);
    const nameLength = directory.getUint16(at + 28, true);
    const extraLength = directory.getUint16(at + 30, true);
    const commentLength = directory.getUint16(at + 32, true);
    const localOffset = directory.getUint32(at + 42, true);
    const name = decoder.decode(new Uint8Array(directory.buffer, at + 46, nameLength));
    at += 46 + nameLength + extraLength + commentLength;

    if (method !== 0) throw new Error(`"${name}" is compressed; only archives made by Tuner can be read`);

    const local = new DataView(await file.slice(localOffset, localOffset + 30).arrayBuffer());
    if (local.getUint32(0, true) !== LOCAL_SIGNATURE) throw new Error(`"${name}" is damaged`);
    const start = localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    if (start + size > file.size) throw new Error(`"${name}" is cut short`);

    const data = file.slice(start, start + size);
    if (crc32(new Uint8Array(await data.arrayBuffer())) !== crc) throw new Error(`"${name}" does not match its checksum`);
    entries.set(name, data);
  }
  return entries;
}
