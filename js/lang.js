// Language detection: distinguish Japanese (ja) from English (en).
// Strategy: if a sentence contains kana (hiragana/katakana) or CJK characters,
// treat it as Japanese; otherwise English. For pure CJK (which could also be
// Chinese), this tool defaults to Japanese, and the user can override in the UI.

// Hiragana 3040–309F, Katakana 30A0–30FF, CJK ideographs 4E00–9FFF,
// half-width katakana FF66–FF9F, Japanese punctuation, etc.
const JA_KANA = /[぀-ヿｦ-ﾟ]/;
const CJK = /[㐀-䶿一-鿿]/;

export const LOCALES = {
  ja: 'ja-JP',
  en: 'en-US',
};

/**
 * Detect the language of a single sentence.
 * @param {string} sentence
 * @returns {'ja' | 'en'}
 */
export function detectLang(sentence) {
  if (!sentence) return 'en';
  // Has kana → definitely Japanese
  if (JA_KANA.test(sentence)) return 'ja';
  // No kana but has CJK → treated as Japanese here (user can change it)
  if (CJK.test(sentence)) return 'ja';
  return 'en';
}
