// The two languages this app practises, and their mapping to the locale codes
// speech services use.
//
// `lang` ('ja' | 'en') is what the app stores and reasons about; a locale
// ('ja-JP' | 'en-US') exists only at the boundary where a service is asked for
// something. Keeping them distinct is why no vendor locale string ends up
// persisted in a record.

export const LANGS = ['ja', 'en'];

export const LOCALES = {
  ja: 'ja-JP',
  en: 'en-US',
};

export const DEFAULT_LANG = 'ja';

/**
 * What to call each language in the interface.
 *
 * English names, because the interface is in English. The sentence rows show
 * the native name instead ("日本語"), since there the label is the language
 * speaking for itself rather than a setting being described.
 */
export const LANG_NAMES = {
  ja: 'Japanese',
  en: 'English',
};

/** Locale for a lang, for a request. Falls back to the default rather than throwing: a
 *  record with an unexpected lang should still be speakable. */
export const localeOf = (lang) => LOCALES[lang] || LOCALES[DEFAULT_LANG];

/**
 * The lang a service's locale corresponds to.
 *
 * Anything that is not Japanese maps to 'en': the app has exactly two
 * languages, and a recognised locale outside them (a service occasionally
 * returns a neighbouring one) is far better treated as English than dropped.
 */
export const langOfLocale = (locale) => (String(locale || '').toLowerCase().startsWith('ja') ? 'ja' : 'en');

/** Every locale a transcription request should consider. */
export const ALL_LOCALES = LANGS.map((lang) => LOCALES[lang]);
