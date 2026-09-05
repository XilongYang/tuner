import './setup-indexeddb.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetStores } from './store-test-helpers.mjs';
import {
  createSession, updateSession, getSession, listSessions, deleteSession,
  migrateSessionIdsToUuid, backfillInputTextHashes, upsertSessions,
} from '../js/store/sessions.js';

beforeEach(resetStores);

test('createSession: assigns a UUID id, stamps timestamps and inputTextHash', async () => {
  const id = await createSession({ inputText: 'hello world', splitMode: 'auto', sentences: [] });
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const session = await getSession(id);
  assert.equal(session.inputText, 'hello world');
  assert.match(session.inputTextHash, /^[0-9a-f]{64}$/);
  assert.ok(session.createdAt > 0);
  assert.equal(session.updatedAt, session.createdAt);
  assert.equal(session.metaUpdatedAt, session.createdAt);
  assert.equal(session.folderId, null);
});

test('createSession: sentences are stamped with recordingHash/updatedAt via stampSentenceVersions', async () => {
  const id = await createSession({
    inputText: 'a. b.',
    splitMode: 'auto',
    sentences: [{ id: 's1', text: 'a.', lang: 'en', hidden: false }],
  });
  const session = await getSession(id);
  assert.equal(session.sentences.length, 1);
  assert.ok(session.sentences[0].updatedAt > 0);
});

test('getSession: returns undefined for an id that does not exist', async () => {
  const session = await getSession('does-not-exist');
  assert.equal(session, undefined);
});

test('updateSession: no-op (returns null) for a missing id', async () => {
  const result = await updateSession('does-not-exist', { name: 'x' });
  assert.equal(result, null);
});

test('updateSession: renaming bumps metaUpdatedAt but not sentence updatedAt', async () => {
  const id = await createSession({
    inputText: 'hi', splitMode: 'auto', sentences: [{ id: 's1', text: 'hi', lang: 'en', hidden: false }],
  });
  const before = await getSession(id);
  await new Promise((r) => setTimeout(r, 5)); // ensure Date.now() actually advances
  const updated = await updateSession(id, { name: 'My Session' });
  assert.equal(updated.name, 'My Session');
  assert.ok(updated.metaUpdatedAt > before.metaUpdatedAt);
  assert.equal(updated.sentences[0].updatedAt, before.sentences[0].updatedAt);
});

test('updateSession: editing sentence text does NOT bump metaUpdatedAt (only per-sentence updatedAt)', async () => {
  const id = await createSession({
    inputText: 'hi', splitMode: 'auto', sentences: [{ id: 's1', text: 'hi', lang: 'en', hidden: false }],
  });
  const before = await getSession(id);
  await new Promise((r) => setTimeout(r, 5));
  const updated = await updateSession(id, {
    sentences: [{ id: 's1', text: 'changed', lang: 'en', hidden: false }],
  });
  assert.equal(updated.metaUpdatedAt, before.metaUpdatedAt);
  assert.notEqual(updated.sentences[0].updatedAt, before.sentences[0].updatedAt);
});

test('listSessions: returns sessions newest-updated first', async () => {
  const id1 = await createSession({ inputText: 'first', splitMode: 'auto', sentences: [] });
  await new Promise((r) => setTimeout(r, 5));
  const id2 = await createSession({ inputText: 'second', splitMode: 'auto', sentences: [] });
  const all = await listSessions();
  assert.deepEqual(all.map((s) => s.id), [id2, id1]);
});

test('deleteSession: removes the record and records a session tombstone', async () => {
  const id = await createSession({ inputText: 'x', splitMode: 'auto', sentences: [] });
  await deleteSession(id);
  assert.equal(await getSession(id), undefined);

  const { listTombstones } = await import('../js/store/tombstones.js');
  const tombstones = await listTombstones();
  assert.ok(tombstones.some((t) => t.id === `session:${id}`));
});

test('migrateSessionIdsToUuid: gives a legacy numeric-id session a fresh UUID, preserving its data', async () => {
  const { getStore, wrap, STORE } = await import('../js/store/db.js');
  const s = await getStore('readwrite', STORE);
  const legacyId = await wrap(s.add({
    id: 42, // simulate the pre-UUID legacy id shape; STORE's keyPath is 'id' with autoIncrement, but an explicit numeric id is still accepted
    inputText: 'legacy session',
    sentences: [{ id: 1, text: 'legacy sentence' }],
    createdAt: 1, updatedAt: 1,
  }));
  assert.equal(legacyId, 42);

  const migrated = await migrateSessionIdsToUuid();
  assert.equal(migrated, 1);

  const all = await listSessions();
  assert.equal(all.length, 1);
  assert.notEqual(all[0].id, 42);
  assert.match(all[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-/i);
  assert.equal(all[0].inputText, 'legacy session');
  assert.notEqual(all[0].sentences[0].id, 1);
});

test('migrateSessionIdsToUuid: a no-op (returns 0) once every session is already UUID-keyed', async () => {
  await createSession({ inputText: 'already fine', splitMode: 'auto', sentences: [] });
  const migrated = await migrateSessionIdsToUuid();
  assert.equal(migrated, 0);
});

test('backfillInputTextHashes: fills inputTextHash for a session that predates the field', async () => {
  const { getStore, wrap, STORE } = await import('../js/store/db.js');
  const s = await getStore('readwrite', STORE);
  const id = await wrap(s.add({
    id: 'legacy-uuid-shape', inputText: 'needs a hash', sentences: [], createdAt: 1, updatedAt: 1,
    // inputTextHash intentionally omitted
  }));

  const count = await backfillInputTextHashes();
  assert.equal(count, 1);
  const session = await getSession(id);
  assert.match(session.inputTextHash, /^[0-9a-f]{64}$/);
});

test('backfillInputTextHashes: skips sessions with no inputText, and is a no-op the second time', async () => {
  await createSession({ inputText: '', splitMode: 'auto', sentences: [] });
  const first = await backfillInputTextHashes();
  assert.equal(first, 0);
});

test('upsertSessions: writes already-merged records as-is without recomputing updatedAt', async () => {
  await upsertSessions([{ id: 'remote-1', inputText: 'from sync', updatedAt: 999, sentences: [] }]);
  const session = await getSession('remote-1');
  assert.equal(session.updatedAt, 999);
});

test('upsertSessions: a no-op on an empty/undefined list', async () => {
  await upsertSessions([]);
  await upsertSessions(undefined);
  assert.deepEqual(await listSessions(), []);
});
