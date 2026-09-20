import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettings, SETTINGS_KEYS } from '../../js/platform/settings.js';
import { DEFAULT_VOICES } from '../../js/model/voices.js';

/** A storage that behaves like the real one, and can be told to misbehave. */
function fakeStorage({ failOn = null, seed = {} } = {}) {
  const map = new Map(Object.entries(seed));
  const guard = (op) => { if (failOn === op || failOn === 'all') throw new DOMException('denied'); };
  return {
    getItem: (key) => { guard('get'); return map.has(key) ? map.get(key) : null; },
    setItem: (key, value) => { guard('set'); map.set(key, String(value)); },
    removeItem: (key) => { guard('remove'); map.delete(key); },
    _map: map,
  };
}

test('credentials: round-trip key, region and resource name', () => {
  const storage = fakeStorage();
  const settings = createSettings(storage);

  assert.equal(settings.saveCredentials({ key: 'k', region: 'japaneast', resourceName: 'res' }), true);
  assert.deepEqual(settings.credentials(), { key: 'k', region: 'japaneast', resourceName: 'res' });
  assert.equal(settings.hasCredentials(), true);
});

test('credentials: absent until both key and region are present', () => {
  const settings = createSettings(fakeStorage());
  assert.equal(settings.credentials(), null);
  assert.equal(settings.hasCredentials(), false);

  settings.saveCredentials({ key: 'k', region: '' });
  assert.equal(settings.credentials(), null, 'a half-filled credential is not configured');

  settings.saveCredentials({ key: '', region: 'japaneast' });
  assert.equal(settings.credentials(), null);
});

test('credentials: a missing resource name does not make the other operations look unconfigured', () => {
  // Only transcription needs it; synthesis and scoring must still work.
  const settings = createSettings(fakeStorage());
  settings.saveCredentials({ key: 'k', region: 'japaneast' });
  assert.equal(settings.hasCredentials(), true);
  assert.equal(settings.credentials().resourceName, '');
});

test('credentials: corrupt stored JSON reads as absent rather than throwing later', () => {
  const settings = createSettings(fakeStorage({ seed: { [SETTINGS_KEYS.credentials]: '{not json' } }));
  assert.equal(settings.credentials(), null);
});

test('credentials: clearing removes them', () => {
  const settings = createSettings(fakeStorage());
  settings.saveCredentials({ key: 'k', region: 'r' });
  settings.clearCredentials();
  assert.equal(settings.credentials(), null);
});

test('sasUrl: round-trips, and saving an empty value clears it', () => {
  const settings = createSettings(fakeStorage());
  assert.equal(settings.sasUrl(), null);

  settings.saveSasUrl('https://acct.blob.core.windows.net/tuner?sig=x');
  assert.match(settings.sasUrl(), /^https:/);

  settings.saveSasUrl('');
  assert.equal(settings.sasUrl(), null);
});

test('voice: falls back to a default until one is chosen', () => {
  const settings = createSettings(fakeStorage());
  assert.equal(settings.voice('ja-JP'), DEFAULT_VOICES['ja-JP']);

  settings.saveVoice('ja-JP', 'ja-JP-KeitaNeural');
  assert.equal(settings.voice('ja-JP'), 'ja-JP-KeitaNeural');
  assert.equal(settings.voice('en-US'), DEFAULT_VOICES['en-US'], 'the other locale is untouched');
});

test('voice: an unknown locale still yields a usable voice rather than undefined', () => {
  assert.ok(createSettings(fakeStorage()).voice('ko-KR'));
});

test('deviceId: minted once, then stable', () => {
  const storage = fakeStorage();
  const settings = createSettings(storage);
  let minted = 0;
  const generate = () => `id-${++minted}`;

  assert.equal(settings.deviceId(generate), 'id-1');
  assert.equal(settings.deviceId(generate), 'id-1');
  assert.equal(minted, 1);
});

test('lastSessionId and historyOpen: round-trip, with sane defaults', () => {
  const settings = createSettings(fakeStorage());
  assert.equal(settings.lastSessionId(), null);
  assert.equal(settings.historyOpen(), false);

  settings.saveLastSessionId('sess1');
  settings.saveHistoryOpen(true);
  assert.equal(settings.lastSessionId(), 'sess1');
  assert.equal(settings.historyOpen(), true);

  settings.saveLastSessionId(null);
  settings.saveHistoryOpen(false);
  assert.equal(settings.lastSessionId(), null);
  assert.equal(settings.historyOpen(), false);
});

test('storage that throws on read behaves as empty rather than breaking the app', () => {
  const settings = createSettings(fakeStorage({ failOn: 'get' }));
  assert.equal(settings.credentials(), null);
  assert.equal(settings.sasUrl(), null);
  assert.equal(settings.lastSessionId(), null);
  assert.equal(settings.historyOpen(), false);
  assert.ok(settings.voice('ja-JP'), 'still yields a default voice');
});

test('storage that throws on write reports failure instead of throwing', () => {
  // Quota exhausted, or storage disabled mid-session: losing a preference must
  // not take down whatever the user was doing.
  const settings = createSettings(fakeStorage({ failOn: 'set' }));
  assert.equal(settings.saveCredentials({ key: 'k', region: 'r' }), false);
  assert.equal(settings.saveSasUrl('https://x'), false);
  assert.equal(settings.saveHistoryOpen(true), false);
});

test('a deviceId can still be produced when storage refuses writes', () => {
  const settings = createSettings(fakeStorage({ failOn: 'set' }));
  assert.equal(settings.deviceId(() => 'fresh'), 'fresh', 'sync can still name this device this session');
});

test('hideText: off until it is turned on, and remembered once it is', () => {
  const settings = createSettings(fakeStorage());
  assert.equal(settings.hideText(), false);

  settings.saveHideText(true);
  assert.equal(settings.hideText(), true);

  settings.saveHideText(false);
  assert.equal(settings.hideText(), false);
});

test('every setting lives under its own key, so nothing collides', () => {
  const storage = fakeStorage();
  const settings = createSettings(storage);
  settings.saveCredentials({ key: 'k', region: 'r' });
  settings.saveSasUrl('https://x');
  settings.saveVoice('ja-JP', 'v');
  settings.saveLastSessionId('s');
  settings.saveHistoryOpen(true);
  settings.saveHideText(true);
  settings.deviceId(() => 'd');

  assert.deepEqual([...storage._map.keys()].sort(), Object.values(SETTINGS_KEYS).sort());
});

test('no credential is reachable from anything a backup or a sync would carry', () => {
  // The keys are namespaced and separate; nothing here is ever put into a
  // session record, which is what keeps a key out of an exported archive.
  const storage = fakeStorage();
  createSettings(storage).saveCredentials({ key: 'super-secret', region: 'r' });
  assert.ok([...storage._map.keys()].every((key) => key.startsWith('tuner.')));
  assert.equal(storage._map.get(SETTINGS_KEYS.sasUrl), undefined);
});
