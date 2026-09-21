import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashBlob, hashString, hashJson, materializeBlob } from '../../js/platform/hash.js';

// The known SHA-256 of "abc", so these assert the actual algorithm rather than
// just "returns 64 hex characters" -- a hash of the wrong bytes would pass that.
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

test('hashString: is a real SHA-256 of the UTF-8 bytes', async () => {
  assert.equal(await hashString('abc'), SHA256_ABC);
});

test('hashBlob: hashes the bytes, not the Blob\'s string form', async () => {
  const blob = new Blob([new TextEncoder().encode('abc')]);
  assert.equal(await hashBlob(blob), SHA256_ABC);
});

test('hashBlob: identical bytes hash the same regardless of declared type', async () => {
  const wav = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
  const octet = new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' });
  assert.equal(await hashBlob(wav), await hashBlob(octet));
});

test('hashBlob: one different byte gives a different hash', async () => {
  const a = await hashBlob(new Blob([new Uint8Array([1, 2, 3])]));
  const b = await hashBlob(new Blob([new Uint8Array([1, 2, 4])]));
  assert.notEqual(a, b);
});

test('hashJson: hashes the exact serialization that will be stored', async () => {
  const value = { score: 0, words: [] };
  assert.equal(await hashJson(value), await hashString(JSON.stringify(value)));
});

test('materializeBlob: produces a self-contained copy with the same bytes and type', async () => {
  const original = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
  const copy = await materializeBlob(original);
  assert.notEqual(copy, original);
  assert.equal(copy.type, 'audio/wav');
  assert.equal(await hashBlob(copy), await hashBlob(original));
});

test('materializeBlob: passes null through', async () => {
  assert.equal(await materializeBlob(null), null);
});
