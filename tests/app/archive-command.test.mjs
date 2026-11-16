// Export and import: an archive is a sync container held in a file, so the
// tests are the round-trip, and the merge rules the sync already guarantees.
import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { exportArchive, importArchive } from '../../js/app/commands/archive.js';
import * as db from '../../js/db/entities.js';
import { transact, ALL_STORES, request } from '../../js/db/open.js';
import { blankSentence } from '../../js/model/session.js';
import { hashBlob, hashString, materializeBlob } from '../../js/platform/hash.js';
import { readZip, writeZip } from '../../js/platform/zip.js';
import { seed } from '../helpers/seed.mjs';

const hash = { materializeBlob };
const clip = (bytes) => new Blob([new Uint8Array(bytes)], { type: 'audio/wav' });

async function wipe() {
  await transact(ALL_STORES, 'readwrite', async (stores) => {
    for (const name of ALL_STORES) await request(stores[name].clear());
  });
}

async function seedSession({ id = 'sess1', text = 'hello', recording = null, updatedAt = 10 } = {}) {
  const sentence = blankSentence({ id: `${id}-s1`, text, lang: 'en', now: 10 });
  if (recording) {
    sentence.recording = recording;
    sentence.recordingHash = await hashBlob(recording);
  }
  await seed('sessions', {
    id, name: null, splitMode: 'auto', createdAt: 1, updatedAt, metaUpdatedAt: updatedAt,
    inputText: 'typed', inputTextHash: await hashString('typed'),
    sourceAudio: null, sourceAudioHash: null, sentences: [sentence],
  });
}

beforeEach(wipe);

test('exported and imported on an empty device, a session comes back with its recording', async () => {
  await seedSession({ recording: clip([4, 5, 6]) });
  const exported = await exportArchive({ db, hash });
  assert.equal(exported.sessions, 1);
  assert.deepEqual(exported.missing, []);

  await wipe();
  const result = await importArchive({ db, hash, file: exported.blob });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.added, 1);

  const [session] = await db.listAll('sessions');
  assert.equal(session.inputText, 'typed');
  assert.deepEqual([...new Uint8Array(await session.sentences[0].recording.arrayBuffer())], [4, 5, 6]);
});

test('importing the same file again changes nothing', async () => {
  await seedSession({ recording: clip([1, 2]) });
  const { blob } = await exportArchive({ db, hash });
  await wipe();
  await importArchive({ db, hash, file: blob });
  const before = await db.snapshot();

  const again = await importArchive({ db, hash, file: blob });
  assert.equal(again.ok, true);
  assert.equal(again.added, 0);
  assert.deepEqual(await db.snapshot(), before);
});

test('an import merges: what is only here is kept, and a newer edit here beats the file', async () => {
  await seedSession({ id: 'old', text: 'in the file', updatedAt: 10 });
  const { blob } = await exportArchive({ db, hash });

  await seedSession({ id: 'old', text: 'edited here later', updatedAt: 99 });
  await seedSession({ id: 'only-here', text: 'local only' });

  const result = await importArchive({ db, hash, file: blob });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.added, 0);
  const sessions = await db.listAll('sessions', { content: false });
  assert.deepEqual(sessions.map((s) => s.id).sort(), ['old', 'only-here']);
  assert.equal(sessions.find((s) => s.id === 'old').sentences[0].text, 'edited here later');
});

test('a deletion made here is not undone by an older file', async () => {
  await seedSession({ id: 'gone' });
  const { blob } = await exportArchive({ db, hash });
  await db.remove('sessions', 'gone', 500);

  await importArchive({ db, hash, file: blob });
  assert.deepEqual(await db.listAll('sessions', { content: false }), []);
});

test('a file that is not an archive changes nothing and says why', async () => {
  await seedSession();
  const before = await db.snapshot();

  const notZip = await importArchive({ db, hash, file: new Blob(['plain text']) });
  assert.equal(notZip.ok, false);
  assert.match(notZip.reason, /could not be read/);

  const noManifest = await importArchive({ db, hash, file: await writeZip([{ name: 'x', data: new Uint8Array([1]) }]) });
  assert.equal(noManifest.ok, false);
  assert.match(noManifest.reason, /not a Tuner archive/);

  assert.deepEqual(await db.snapshot(), before);
});

test('an archive from a newer version is refused rather than merged', async () => {
  const file = await writeZip([{ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({ version: 999, sessions: [], vocab: [], tombstones: [] })) }]);
  const result = await importArchive({ db, hash, file });
  assert.equal(result.ok, false);
  assert.match(result.reason, /newer version/);
});

test('a clip missing from the file is warned about, and the session still arrives', async () => {
  await seedSession({ recording: clip([7, 8]) });
  const { blob } = await exportArchive({ db, hash });
  const entries = await readZip(blob);
  const cut = await writeZip([...entries].filter(([name]) => name === 'manifest.json').map(([name, data]) => ({ name, data })));

  await wipe();
  const result = await importArchive({ db, hash, file: cut });
  assert.equal(result.ok, true);
  assert.equal(result.added, 1);
  assert.equal(result.warnings.length, 2, 'the recording and the practice text, both named by the manifest');
});

test('a recording whose bytes are gone is left out of the file and out of its claims', async () => {
  await seedSession({ recording: clip([1, 2, 3]) });
  await transact(ALL_STORES, 'readwrite', async (s) => { await request(s.content.clear()); });

  const exported = await exportArchive({ db, hash });
  assert.equal(exported.missing.length, 2, 'the recording and the practice text');
  const manifest = JSON.parse(await (await readZip(exported.blob)).get('manifest.json').text());
  assert.equal(JSON.stringify(manifest).includes(await hashBlob(clip([1, 2, 3]))), false);
});
