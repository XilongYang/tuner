import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGS, LOCALES, localeOf, langOfLocale, ALL_LOCALES, DEFAULT_LANG } from '../../js/model/lang.js';

test('localeOf: maps each language to its locale', () => {
  assert.equal(localeOf('ja'), 'ja-JP');
  assert.equal(localeOf('en'), 'en-US');
});

test('localeOf: an unexpected language falls back rather than throwing, so a record stays speakable', () => {
  assert.equal(localeOf('fr'), LOCALES[DEFAULT_LANG]);
  assert.equal(localeOf(undefined), LOCALES[DEFAULT_LANG]);
});

test('langOfLocale: any Japanese locale variant maps to ja', () => {
  assert.equal(langOfLocale('ja-JP'), 'ja');
  assert.equal(langOfLocale('JA-jp'), 'ja');
  assert.equal(langOfLocale('ja'), 'ja');
});

test('langOfLocale: everything else maps to en rather than being dropped', () => {
  assert.equal(langOfLocale('en-US'), 'en');
  assert.equal(langOfLocale('en-GB'), 'en');
  assert.equal(langOfLocale('ko-KR'), 'en');
  assert.equal(langOfLocale(null), 'en');
});

test('ALL_LOCALES covers every language the app has', () => {
  assert.deepEqual(ALL_LOCALES, LANGS.map((l) => LOCALES[l]));
  assert.equal(ALL_LOCALES.length, 2);
});
