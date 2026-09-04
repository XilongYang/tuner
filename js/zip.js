// Minimal ZIP writer (store method, no compression). Zero dependencies.
// Enough to bundle a few files (text + audio + json) into a downloadable archive.

/** CRC-32 (IEEE) of a byte array. */
function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

/** ASCII string → bytes (filenames are kept ASCII). */
function asciiBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Build a ZIP Blob from a list of files.
 * @param {Array<{ name: string, data: Uint8Array }>} files
 * @returns {Blob}
 */
export function makeZip(files) {
  const parts = [];   // local headers + data, in order
  const central = []; // central directory records
  let offset = 0;

  for (const f of files) {
    const nameBytes = asciiBytes(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); // local file header signature
    lh.setUint16(4, 20, true);         // version needed
    lh.setUint16(6, 0, true);          // flags
    lh.setUint16(8, 0, true);          // compression = store
    lh.setUint16(10, 0, true);         // mod time
    lh.setUint16(12, 0, true);         // mod date
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);      // compressed size
    lh.setUint32(22, size, true);      // uncompressed size
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);         // extra length
    const lhBytes = new Uint8Array(lh.buffer);
    parts.push(lhBytes, nameBytes, f.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); // central dir signature
    cd.setUint16(4, 20, true);         // version made by
    cd.setUint16(6, 20, true);         // version needed
    cd.setUint16(8, 0, true);          // flags
    cd.setUint16(10, 0, true);         // compression
    cd.setUint16(12, 0, true);         // mod time
    cd.setUint16(14, 0, true);         // mod date
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true);         // extra length
    cd.setUint16(32, 0, true);         // comment length
    cd.setUint16(34, 0, true);         // disk number
    cd.setUint16(36, 0, true);         // internal attrs
    cd.setUint32(38, 0, true);         // external attrs
    cd.setUint32(42, offset, true);    // local header offset
    central.push(new Uint8Array(cd.buffer), nameBytes);

    offset += lhBytes.length + nameBytes.length + size;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) centralSize += c.length;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); // end of central dir signature
  eocd.setUint16(4, 0, true);          // disk number
  eocd.setUint16(6, 0, true);          // central dir start disk
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralStart, true);
  eocd.setUint16(20, 0, true);         // comment length

  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)],
    { type: 'application/zip' });
}

/**
 * Read a ZIP back into its list of files -- the counterpart to makeZip()
 * above, for round-tripping this app's own exports (the full-history .tuner
 * backup in store/backup.js). Walks the local file headers directly rather
 * than the central directory, so it doesn't need EOCD parsing; that only
 * works because it's reading exactly what makeZip() writes. Only supports
 * uncompressed ("store") entries -- what makeZip() always produces -- and
 * throws a clear error on anything else (e.g. a real compressed ZIP), since
 * this isn't a general-purpose ZIP reader.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Array<{ name: string, data: Uint8Array }>}
 */
export function readZip(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const files = [];
  let offset = 0;
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const compression = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = new TextDecoder('ascii').decode(bytes.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    if (compression !== 0) {
      throw new Error(`Unsupported compressed entry "${name}" — only uncompressed .tuner backups are supported.`);
    }
    files.push({ name, data: bytes.slice(dataStart, dataStart + compressedSize) });
    offset = dataStart + compressedSize;
  }
  if (!files.length) throw new Error('Not a valid .tuner backup (no files found).');
  return files;
}
