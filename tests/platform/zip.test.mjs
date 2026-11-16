import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, readZip, writeZip } from '../../js/platform/zip.js';

const bytes = (...values) => new Uint8Array(values);
const read = async (blob) => [...new Uint8Array(await blob.arrayBuffer())];

test('crc32 matches the published check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('what is written is read back, names and bytes, including an empty file and a UTF-8 name', async () => {
  const zip = await writeZip([
    { name: 'manifest.json', data: new TextEncoder().encode('{"a":1}') },
    { name: 'sessions/日本語.audio', data: new Blob([bytes(1, 2, 3)]) },
    { name: 'empty', data: bytes() },
  ]);
  const entries = await readZip(zip);
  assert.deepEqual([...entries.keys()], ['manifest.json', 'sessions/日本語.audio', 'empty']);
  assert.equal(await entries.get('manifest.json').text(), '{"a":1}');
  assert.deepEqual(await read(entries.get('sessions/日本語.audio')), [1, 2, 3]);
  assert.equal(entries.get('empty').size, 0);
});

test('an archive with no entries is still a zip', async () => {
  assert.equal((await readZip(await writeZip([]))).size, 0);
});

test('something that is not a zip is refused', async () => {
  await assert.rejects(readZip(new Blob(['hello, not a zip file at all'])), /not a zip/);
});

test('a truncated file is refused, not read as a smaller archive', async () => {
  const zip = await writeZip([{ name: 'a', data: bytes(1, 2, 3, 4) }]);
  await assert.rejects(readZip(zip.slice(0, zip.size - 10)));
});

test('a flipped byte in an entry is caught by its checksum', async () => {
  const zip = await writeZip([{ name: 'a', data: bytes(1, 2, 3, 4) }]);
  const raw = new Uint8Array(await zip.arrayBuffer());
  raw[30 + 1] ^= 0xff; // first data byte: 30-byte header, 1-byte name, so index 31
  await assert.rejects(readZip(new Blob([raw])), /checksum/);
});
