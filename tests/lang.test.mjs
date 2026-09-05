import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLang, LOCALES } from '../js/lang.js';

test('detectLang: empty/falsy defaults to en', () => {
  assert.equal(detectLang(''), 'en');
  assert.equal(detectLang(null), 'en');
  assert.equal(detectLang(undefined), 'en');
});

test('detectLang: kana (hiragana/katakana) is Japanese', () => {
  assert.equal(detectLang('こんにちは'), 'ja');
  assert.equal(detectLang('コーヒー'), 'ja');
});

test('detectLang: plain English is en', () => {
  assert.equal(detectLang('Hello world'), 'en');
});

test('detectLang: pure CJK with no kana defaults to Japanese', () => {
  assert.equal(detectLang('中国'), 'ja');
});

test('detectLang: mixed Japanese+English sentence is ja (kana wins)', () => {
  assert.equal(detectLang('Hello これはtestです'), 'ja');
});

test('LOCALES: maps ja/en to BCP-47 tags', () => {
  assert.equal(LOCALES.ja, 'ja-JP');
  assert.equal(LOCALES.en, 'en-US');
});
