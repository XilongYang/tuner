import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeZip, readZip } from '../js/zip.js';

async function blobToArrayBuffer(blob) {
  return blob.arrayBuffer();
}

test('makeZip/readZip: round-trips a single small text file', async () => {
  const data = new TextEncoder().encode('hello world');
  const blob = makeZip([{ name: 'a.txt', data }]);
  const buf = await blobToArrayBuffer(blob);
  const files = readZip(buf);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'a.txt');
  assert.deepEqual(Array.from(files[0].data), Array.from(data));
});

test('makeZip/readZip: round-trips multiple files, preserving order and bytes', async () => {
  const f1 = { name: 'one.wav', data: new Uint8Array([1, 2, 3, 4, 5]) };
  const f2 = { name: 'two.json', data: new TextEncoder().encode('{"a":1}') };
  const f3 = { name: 'empty.txt', data: new Uint8Array(0) };
  const blob = makeZip([f1, f2, f3]);
  const buf = await blobToArrayBuffer(blob);
  const files = readZip(buf);
  assert.equal(files.length, 3);
  assert.equal(files[0].name, 'one.wav');
  assert.deepEqual(Array.from(files[0].data), Array.from(f1.data));
  assert.equal(files[1].name, 'two.json');
  assert.deepEqual(Array.from(files[1].data), Array.from(f2.data));
  assert.equal(files[2].name, 'empty.txt');
  assert.deepEqual(Array.from(files[2].data), []);
});

test('makeZip: produces a Blob typed application/zip', () => {
  const blob = makeZip([{ name: 'x.txt', data: new Uint8Array([1]) }]);
  assert.equal(blob.type, 'application/zip');
});

test('readZip: throws a clear error on non-ZIP input (empty buffer is just a degenerate case of this)', () => {
  const buf = new TextEncoder().encode('not a zip at all').buffer;
  assert.throws(() => readZip(buf), /Not a valid \.tuner backup/);
  assert.throws(() => readZip(new ArrayBuffer(0)), /Not a valid \.tuner backup/);
});
