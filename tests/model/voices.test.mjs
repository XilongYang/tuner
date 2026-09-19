import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VOICES, DEFAULT_VOICES, voiceLabel, voiceOptions } from '../../js/model/voices.js';

test('every listed voice has the id shape the service expects', () => {
  // A mistyped id is only found at the point of speaking, as a service error
  // that says nothing about what was wrong. This catches the typo here.
  for (const [locale, list] of Object.entries(VOICES)) {
    assert.ok(list.length, `${locale} offers something`);
    for (const voice of list) {
      assert.match(voice.id, /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/, voice.id);
      assert.ok(voice.id.startsWith(`${voice.locale}-`), `${voice.id} carries its own locale`);
      assert.equal(voice.multilingual, voice.id.endsWith('MultilingualNeural'));
    }
  }
});

test('no voice is listed twice', () => {
  for (const [locale, list] of Object.entries(VOICES)) {
    assert.equal(new Set(list.map((voice) => voice.id)).size, list.length, locale);
  }
});

test('each default is one of the voices offered for its locale', () => {
  for (const [locale, id] of Object.entries(DEFAULT_VOICES)) {
    assert.ok(voiceOptions(locale).some((option) => option.id === id), `${id} is offered for ${locale}`);
  }
});

test('the defaults are the two voices chosen for this app', () => {
  assert.deepEqual(DEFAULT_VOICES, {
    'ja-JP': 'ja-JP-NaokiNeural',
    'en-US': 'en-GB-OllieMultilingualNeural',
  });
});

test('a label names the voice and only what sets it apart', () => {
  assert.equal(voiceLabel({ name: 'Naoki', gender: 'male', locale: 'ja-JP', multilingual: false }, 'ja-JP'), 'Naoki · male');
  assert.equal(
    voiceLabel({ name: 'Ollie', gender: 'male', locale: 'en-GB', multilingual: true }, 'en-US'),
    'Ollie · male · en-GB · multilingual',
    'the locale is worth saying only when it is not the one being chosen for',
  );
  assert.equal(
    voiceLabel({ name: 'Ava', gender: 'female', locale: 'en-US', multilingual: true }, 'en-US'),
    'Ava · female · multilingual',
  );
});

test('a stored voice outside the list is offered back rather than dropped', () => {
  const options = voiceOptions('ja-JP', 'ja-JP-CustomNeural');
  assert.equal(options.at(-1).id, 'ja-JP-CustomNeural');
  assert.equal(options.at(-1).label, 'ja-JP-CustomNeural', 'labelled by its id, which is all that is known about it');
});

test('a stored voice that is in the list is not offered twice', () => {
  const options = voiceOptions('ja-JP', 'ja-JP-KeitaNeural');
  assert.equal(options.filter((option) => option.id === 'ja-JP-KeitaNeural').length, 1);
});

test('an unfamiliar locale still gets a usable list rather than an empty picker', () => {
  assert.ok(voiceOptions('ko-KR').length);
});
