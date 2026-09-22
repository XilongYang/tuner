// Reading an assessment: what the numbers mean, and what each word is marked
// as.
//
// Pure, and separate from the panel that draws it, because the bands are a
// judgement about the domain rather than about the DOM: "80 is good" is the
// same fact in the row, in the legend, and in a per-word popover, and it was
// worth exactly one place to state it.

/** A score at or above this is good; below FAIR_FROM it is poor. */
export const GOOD_FROM = 80;
export const FAIR_FROM = 60;

/**
 * Which band a 0-100 score falls in.
 *
 * The rounded score, because the rounded score is what is printed beside the
 * colour: the service returns fractions, and 79.5 shown as "80" in the band
 * for 60-79 is a chip that argues with the legend three lines below it.
 *
 * Absent or unreadable counts as the lowest band rather than throwing: a
 * missing score is not a reason to lose the whole result, and drawing it as
 * poor is honest about knowing nothing good.
 */
export function accuracyLevel(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return 'bad';
  const shown = Math.round(score);
  if (shown >= GOOD_FROM) return 'good';
  if (shown >= FAIR_FROM) return 'mid';
  return 'bad';
}

/** What the service's error types are called in the interface. */
export const ERROR_LABELS = {
  None: '',
  Mispronunciation: 'mispronounced',
  Omission: 'omission',
  Insertion: 'insertion',
  UnexpectedBreak: 'unexpected break',
  MissingBreak: 'missing break',
  Monotone: 'monotone',
};

/**
 * The four headline numbers, in reading order.
 *
 * Overall first because it is the one people look at; the other three are what
 * it is made of. Each carries its own band, so the caller draws rather than
 * decides.
 */
export function overallScores(assessment) {
  const overall = assessment?.overall || {};
  return [
    ['Overall', overall.pronunciation],
    ['Accuracy', overall.accuracy],
    ['Fluency', overall.fluency],
    ['Completeness', overall.completeness],
  ].map(([label, value]) => ({
    label,
    value: Math.round(value ?? 0),
    level: accuracyLevel(value ?? 0),
  }));
}

/**
 * How one word is marked in the line of words.
 *
 * An omission and an insertion are not bands at all -- one was never spoken
 * and the other was never asked for, so neither has an accuracy worth
 * colouring -- which is why they are a separate field rather than a fourth
 * band.
 */
export function wordMark(word) {
  if (word?.errorType === 'Omission') return { error: 'omission', level: null };
  if (word?.errorType === 'Insertion') return { error: 'insertion', level: null };
  return { error: null, level: accuracyLevel(word?.accuracy) };
}

/**
 * The line at the top of a word's popover.
 *
 * `prefix` is how a retest says it is one: the word keeps its own name, and
 * the number beside it is from the new take rather than the original.
 *
 * @param {object} word The scored word to describe.
 * @param {object} [opts]
 * @param {string} [opts.name] The name to show, when `word` is a retest of a
 *   word the service named differently (it returns what it heard).
 * @param {string} [opts.prefix]
 */
export function wordHeadline(word, { name = null, prefix = '' } = {}) {
  const text = name ?? word?.word ?? '';
  if (word?.errorType === 'Omission') return `${prefix}${text} · omission · in the reference but not spoken`;
  if (word?.errorType === 'Insertion') return `${prefix}${text} · insertion · spoken but not in the reference`;

  const label = ERROR_LABELS[word?.errorType] || '';
  return `${prefix}${text} · accuracy ${Math.round(word?.accuracy ?? 0)}${label ? ` · ${label}` : ''}`;
}

/**
 * Where in the recording this word was heard, or null.
 *
 * Null for a word with no timings -- an omission has no audio at all, and an
 * assessment stored before the timings were kept has none either -- which is a
 * different thing from a zero-length range at the start of the file.
 */
export function wordRange(word) {
  const offsetMs = word?.offsetMs;
  const durationMs = word?.durationMs;
  if (typeof offsetMs !== 'number' || typeof durationMs !== 'number' || !(durationMs > 0)) return null;
  return { offsetMs, durationMs };
}

/** What the colours mean, said once on screen so they do not have to be guessed. */
export const LEGEND = [
  { level: 'good', label: `Good ≥${GOOD_FROM}` },
  { level: 'mid', label: `Fair ${FAIR_FROM}–${GOOD_FROM - 1}` },
  { level: 'bad', label: `Poor <${FAIR_FROM}` },
  { error: 'omission', label: 'Omission' },
  { error: 'insertion', label: 'Insertion' },
];
