// The voices offered for each practice language.
//
// A curated list rather than the service's full catalogue: the service offers
// hundreds, the list can be fetched only with a key, and a dropdown that is
// empty until credentials are entered is worse than a short list that always
// works. Anything not listed here can still be used -- a stored voice that is
// not in the list is offered back as its own option, so a choice made before
// this list existed, or copied from the service's catalogue by hand, survives.
//
// `locale` is the voice's own locale, which is not always the locale it is
// chosen for: the multilingual voices read any of the app's languages, so an
// en-GB voice is a perfectly good choice for English practice, and one of them
// is the default.

import { DEFAULT_LANG, LOCALES } from './lang.js';

const plain = (locale, name, gender) => ({ id: `${locale}-${name}Neural`, name, gender, locale, multilingual: false });
const multi = (locale, name, gender) => ({ id: `${locale}-${name}MultilingualNeural`, name, gender, locale, multilingual: true });
const ja = (name, gender) => plain('ja-JP', name, gender);

/** @type {Record<string, {id: string, name: string, gender: string, locale: string, multilingual: boolean}[]>} */
export const VOICES = {
  'ja-JP': [
    ja('Naoki', 'male'),
    ja('Keita', 'male'),
    ja('Daichi', 'male'),
    ja('Nanami', 'female'),
    ja('Aoi', 'female'),
    ja('Mayu', 'female'),
    ja('Shiori', 'female'),
    multi('ja-JP', 'Masaru', 'male'),
  ],
  'en-US': [
    multi('en-GB', 'Ollie', 'male'),
    multi('en-GB', 'Ada', 'female'),
    multi('en-US', 'Andrew', 'male'),
    multi('en-US', 'Ava', 'female'),
    plain('en-GB', 'Ryan', 'male'),
    plain('en-GB', 'Sonia', 'female'),
    plain('en-US', 'Guy', 'male'),
    plain('en-US', 'Jenny', 'female'),
    plain('en-US', 'Aria', 'female'),
  ],
};

/**
 * The voice used when nothing has been chosen.
 *
 * Both are voices Aspen settled on by listening to them, which is the only way
 * this question is ever answered; they are not the service's own defaults.
 */
export const DEFAULT_VOICES = {
  'ja-JP': 'ja-JP-NaokiNeural',
  'en-US': 'en-GB-OllieMultilingualNeural',
};

/**
 * How a voice reads in the picker: its name, then only what distinguishes it
 * from its neighbours in the list -- its gender, the locale when that is not
 * the locale being chosen for, and whether it is one of the multilingual
 * voices.
 */
export function voiceLabel(voice, forLocale) {
  const parts = [voice.name, voice.gender];
  if (voice.locale !== forLocale) parts.push(voice.locale);
  if (voice.multilingual) parts.push('multilingual');
  return parts.join(' · ');
}

/**
 * The options a picker for `locale` should show, in order.
 *
 * `selected` is included even when it is not in the list: a voice chosen before
 * this list existed must not be silently swapped for the first option -- the
 * picker would then show one voice while the app spoke with another.
 *
 * @returns {{id: string, label: string}[]}
 */
export function voiceOptions(locale, selected = null) {
  const listed = VOICES[locale] || VOICES[LOCALES[DEFAULT_LANG]];
  const options = listed.map((voice) => ({ id: voice.id, label: voiceLabel(voice, locale) }));
  if (selected && !options.some((option) => option.id === selected)) {
    options.push({ id: selected, label: selected });
  }
  return options;
}
