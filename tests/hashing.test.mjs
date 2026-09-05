import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashBlob, hashString, refreshSentenceBlobs, refreshBlobIfPresent, stampSentenceVersions,
} from '../js/store/hashing.js';

test('hashString: deterministic, 64-char hex, differs for different input', async () => {
  const h1 = await hashString('hello');
  const h2 = await hashString('hello');
  const h3 = await hashString('world');
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

test('hashBlob: matches hashString on the same underlying bytes', async () => {
  const text = 'same content';
  const blob = new Blob([text]);
  const fromBlob = await hashBlob(blob);
  const fromString = await hashString(text);
  assert.equal(fromBlob, fromString);
});

test('refreshSentenceBlobs: rewraps recordingBlob/referenceBlob into fresh Blob instances, preserving type', () => {
  const recordingBlob = new Blob(['abc'], { type: 'audio/wav' });
  const referenceBlob = new Blob(['def'], { type: 'audio/mpeg' });
  const [out] = refreshSentenceBlobs([{ id: 's1', recordingBlob, referenceBlob }]);
  assert.notEqual(out.recordingBlob, recordingBlob);
  assert.notEqual(out.referenceBlob, referenceBlob);
  assert.equal(out.recordingBlob.type, 'audio/wav');
  assert.equal(out.referenceBlob.type, 'audio/mpeg');
});

test('refreshSentenceBlobs: passes through non-array input and null entries unchanged', () => {
  assert.equal(refreshSentenceBlobs(null), null);
  assert.deepEqual(refreshSentenceBlobs([null, { id: 's1' }]), [null, { id: 's1' }]);
});

test('refreshBlobIfPresent: rewraps a present blob, passes through a missing one', () => {
  const blob = new Blob(['x'], { type: 'audio/wav' });
  const out = refreshBlobIfPresent(blob);
  assert.notEqual(out, blob);
  assert.equal(out.type, 'audio/wav');
  assert.equal(refreshBlobIfPresent(null), null);
  assert.equal(refreshBlobIfPresent(undefined), undefined);
});

test('stampSentenceVersions: a brand-new sentence (no prev) gets stamped with a fresh updatedAt', async () => {
  const [out] = await stampSentenceVersions([], [{ id: 's1', text: 'hi', lang: 'en', hidden: false }]);
  assert.equal(out.recordingHash, null);
  assert.equal(out.assessmentHash, null);
  assert.ok(out.updatedAt > 0);
});

test('stampSentenceVersions: unchanged fields keep the old updatedAt', async () => {
  const prev = { id: 's1', text: 'hi', lang: 'en', hidden: false, updatedAt: 12345 };
  const [out] = await stampSentenceVersions([prev], [{ id: 's1', text: 'hi', lang: 'en', hidden: false }]);
  assert.equal(out.updatedAt, 12345);
});

test('stampSentenceVersions: a text edit bumps updatedAt to "now"', async () => {
  const prev = { id: 's1', text: 'hi', lang: 'en', hidden: false, updatedAt: 12345 };
  const before = Date.now();
  const [out] = await stampSentenceVersions([prev], [{ id: 's1', text: 'changed', lang: 'en', hidden: false }]);
  assert.ok(out.updatedAt >= before);
  assert.notEqual(out.updatedAt, 12345);
});

test('stampSentenceVersions: a new recording blob bumps updatedAt and sets recordingHash', async () => {
  const prev = { id: 's1', text: 'hi', lang: 'en', hidden: false, updatedAt: 12345, recordingHash: null };
  const incoming = { id: 's1', text: 'hi', lang: 'en', hidden: false, recordingBlob: new Blob(['audio bytes']) };
  const [out] = await stampSentenceVersions([prev], [incoming]);
  assert.notEqual(out.updatedAt, 12345);
  assert.match(out.recordingHash, /^[0-9a-f]{64}$/);
});

test('stampSentenceVersions: assessmentHash is recomputed fresh, not trusted from a stale incoming hash', async () => {
  // Simulate the immutable-update pattern the doc comment warns about: caller
  // spreads the old sentence (carrying its old assessmentHash) but supplies a
  // genuinely different assessment payload.
  const prev = {
    id: 's1', text: 'hi', lang: 'en', hidden: false, updatedAt: 1, assessmentHash: 'stale-hash-value',
  };
  const incoming = {
    ...prev, assessment: { score: 42 }, assessmentHash: 'stale-hash-value',
  };
  const [out] = await stampSentenceVersions([prev], [incoming]);
  assert.notEqual(out.assessmentHash, 'stale-hash-value');
  assert.notEqual(out.updatedAt, 1);
});
