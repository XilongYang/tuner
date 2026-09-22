// Transforms on a session record: splitting a sentence, merging a run of them,
// editing one, replacing the set.
//
// Pure, and addressed by id rather than by array position. That is not a style
// choice: every one of these runs after slow asynchronous work (decoding audio,
// scoring a take), and an index captured before that work no longer means what
// it meant once a split, a merge or an arriving sync has reordered the list.
// Taking ids means a stale caller either finds its sentence or does not, and
// never edits a different one by accident.
//
// Timestamps and new ids are arguments rather than being generated here, so
// these stay pure and their tests stay deterministic. The caller -- a command
// -- supplies them, along with any audio it had to cut, since cutting audio is
// a platform concern.

import { splitText, isSplittable, partitionWords, mergeWords, chars } from './geometry.js';
import { seamSeparator } from './text.js';

export const sentenceById = (session, id) => (session?.sentences || []).find((s) => s.id === id) || null;
export const indexOfSentence = (session, id) => (session?.sentences || []).findIndex((s) => s.id === id);

/** A sentence with no content and no timings: the shape every producer starts from. */
export function blankSentence({ id, text, lang, now, ...rest }) {
  return {
    id,
    text,
    lang,
    hidden: false,
    updatedAt: now,
    words: null,
    referenceSource: null,
    sourceOffsetMs: null,
    sourceDurationMs: null,
    recording: null,
    recordingHash: null,
    reference: null,
    referenceHash: null,
    assessment: null,
    assessmentHash: null,
    ...rest,
  };
}

/** The session's own fields changed; both clocks move. */
const withMeta = (session, now, changes) => ({
  ...session,
  ...changes,
  updatedAt: now,
  metaUpdatedAt: now,
});

/** A sentence changed; the session's own fields did not, so metaUpdatedAt stays put. */
const withSentences = (session, now, sentences) => ({
  ...session,
  sentences,
  updatedAt: now,
});

/**
 * Replace one sentence's fields.
 *
 * Returns the session unchanged (the same object) when there is no such
 * sentence, so a caller acting on something that has since been split or merged
 * away is a no-op rather than an error or a mis-targeted write.
 */
export function updateSentence(session, sentenceId, patch, now) {
  const index = indexOfSentence(session, sentenceId);
  if (index === -1) return session;

  const sentences = [...session.sentences];
  sentences[index] = { ...sentences[index], ...patch, updatedAt: now };
  return withSentences(session, now, sentences);
}

/**
 * Set the same field on every sentence, touching only the ones that differ.
 *
 * A sentence already in the wanted state keeps its `updatedAt`: a global switch
 * must not restamp the whole session and hand a sync a pile of changes that
 * change nothing. When nothing differs, the session comes back unchanged (the
 * same object), so a repaint is not provoked either.
 */
export function setOnEverySentence(session, patch, now) {
  const sentences = session?.sentences || [];
  const changes = sentences.some((sentence) => Object.entries(patch).some(([key, value]) => sentence[key] !== value));
  if (!changes) return session;

  return withSentences(session, now, sentences.map((sentence) => (
    Object.entries(patch).every(([key, value]) => sentence[key] === value)
      ? sentence
      : { ...sentence, ...patch, updatedAt: now }
  )));
}

/**
 * Whether a session is worth storing yet.
 *
 * A blank session is the app's resting state: one is minted at startup, and
 * again every time the workspace is cleared. Storing those fills the library
 * with rows that have nothing in them and nothing to open, and hands the next
 * sync a record that says nothing. A session earns its place by holding
 * something -- sentences, or the audio file an import is being built from.
 *
 * Once stored it stays stored: this decides whether to write a record, not
 * whether to keep one.
 */
export function isWorthStoring(session) {
  return Boolean(session && ((session.sentences || []).length || session.sourceAudio));
}

/** Edit the session's own fields (its name). */
export const updateSession = (session, patch, now) => withMeta(session, now, patch);

/**
 * Split one sentence in two at `charIndex`.
 *
 * The caller supplies the two new ids, and — when it was able to cut the audio —
 * each half's `reference` blob, `referenceHash` and `range`. A half with no
 * reference simply has none: the split still happens, because the text split is
 * what the user asked for, and the caller reports that the audio could not
 * follow.
 *
 * Returns null when the cut would leave a half with nothing but whitespace.
 * `replacedIds` is what the caller must tombstone, so the sentence this split
 * replaced cannot return from another device that has not seen the split yet.
 *
 * @returns {{session: object, replacedIds: string[], added: string[]}|null}
 */
export function splitSentence(session, { sentenceId, charIndex, leftId, rightId, now, left = {}, right = {} }) {
  const index = indexOfSentence(session, sentenceId);
  if (index === -1) return null;

  const sentence = session.sentences[index];
  if (!isSplittable(sentence.text, charIndex)) return null;

  const texts = splitText(sentence.text, charIndex);
  const words = partitionWords(sentence.words, charIndex);

  const half = (id, text, side, ownWords) => blankSentence({
    id,
    text,
    lang: sentence.lang,
    now,
    hidden: sentence.hidden,
    // Same rule as merge: timings belong to the clip they were measured
    // against. A half that kept its share of the audio keeps them; a half that
    // did not is left with text positions only, rather than markers that claim
    // a timestamp into audio it no longer holds.
    words: side.reference && ownWords.length ? ownWords : null,
    // Reference audio survives only where the caller could cut it. Keeping the
    // source markers without the audio would claim a clip that is not there.
    referenceSource: side.reference ? sentence.referenceSource : null,
    reference: side.reference ?? null,
    referenceHash: side.reference ? (side.referenceHash ?? null) : null,
    sourceOffsetMs: side.range?.offsetMs ?? null,
    sourceDurationMs: side.range?.durationMs ?? null,
  });

  const sentences = [...session.sentences];
  sentences.splice(index, 1,
    half(leftId, texts.left, left, words.left),
    half(rightId, texts.right, right, words.right));

  return {
    session: withSentences(session, now, sentences),
    replacedIds: [sentenceId],
    added: [leftId, rightId],
  };
}

/**
 * Merge a run of adjacent sentences into one.
 *
 * Two sentences that came from one split rejoin exactly: the split kept the
 * whitespace at the cut on its left half, so the seam already carries whatever
 * stood there. Two sentences that came from segmenting a block of text do not:
 * segmentation trimmed each one, and the space between them was dropped there.
 * seamSeparator() puts back what that seam needs -- a space between Latin text,
 * nothing between Japanese -- so the merged sentence reads as it was written.
 * It is not a cosmetic matter: this text is what gets read aloud and scored.
 *
 * Nothing records where the join was. A merged sentence is one sentence, and
 * its cut positions are whatever it can actually be cut at now: its word
 * boundaries when it kept a clip, the text's own positions when it did not --
 * which include the join, since a join is at a word boundary. A separate mark
 * for the seam offered the same positions a second time, in a second colour,
 * and outlived the only case it was for.
 *
 * Returns null unless the ids name two or more sentences that are adjacent and
 * in order.
 *
 * @returns {{session: object, replacedIds: string[], added: string[]}|null}
 */
export function mergeSentences(session, { sentenceIds, newId, now, reference = null, referenceHash = null, range = null }) {
  if (!sentenceIds || sentenceIds.length < 2) return null;

  const indices = sentenceIds.map((id) => indexOfSentence(session, id));
  if (indices.some((i) => i === -1)) return null;

  const sorted = [...indices].sort((a, b) => a - b);
  const adjacent = sorted.every((value, i) => i === 0 || value === sorted[i - 1] + 1);
  if (!adjacent) return null;

  const run = sorted.map((i) => session.sentences[i]);

  // Each piece carries the separator that belongs after it, so a word's
  // position inside its own piece is unchanged and the seam between two pieces
  // lands at the start of the next one -- which is where splitting again cuts,
  // leaving the separator on the left half exactly as a split always does.
  const own = run.map((s) => s.text);
  const texts = own.map((text, i) => (i === own.length - 1 ? text : text + seamSeparator(text, own[i + 1])));

  const merged = blankSentence({
    id: newId,
    text: texts.join(''),
    // The run's first sentence decides: a merge is joining a sentence to what
    // follows it, and one label has to cover the result.
    lang: run[0].lang,
    now,
    hidden: run.every((s) => s.hidden),
    // Word timings describe one clip. They survive only onto a sentence that
    // holds the clip they describe -- the re-cut source range, whose timeline
    // they are already on. Without it they are worse than nothing: each piece's
    // timings were measured against its own reading, both starting at zero, so
    // the merged sentence would offer exact-looking cut markers at times that
    // belong to audio it does not have. Speaking it again produces one clip and
    // one set of timings for the whole of it.
    words: reference ? mergeWords(run.map((s) => s.words), texts) : null,
    referenceSource: reference ? run[0].referenceSource : null,
    reference,
    referenceHash: reference ? referenceHash : null,
    sourceOffsetMs: range?.offsetMs ?? null,
    sourceDurationMs: range?.durationMs ?? null,
  });

  const sentences = [...session.sentences];
  sentences.splice(sorted[0], sorted.length, merged);

  return {
    session: withSentences(session, now, sentences),
    replacedIds: run.map((s) => s.id),
    added: [newId],
  };
}

/**
 * Whether a run of ids can be merged: at least two, all present, adjacent.
 * Separate from `mergeSentences` so the UI can enable its control without
 * building a result to find out.
 */
export function canMerge(session, sentenceIds) {
  if (!sentenceIds || sentenceIds.length < 2) return false;
  const indices = sentenceIds.map((id) => indexOfSentence(session, id));
  if (indices.some((i) => i === -1)) return false;
  const sorted = [...indices].sort((a, b) => a - b);
  return sorted.every((value, i) => i === 0 || value === sorted[i - 1] + 1);
}

/**
 * Which sentences may have their merge selection changed, given what is already
 * selected.
 *
 * A merge joins a run, so the selection is held to a run as it is being made,
 * rather than letting one be built that cannot be merged and refusing it
 * afterwards. With nothing selected, anything can start one. With a run
 * selected, the two sentences touching its ends can extend it and its own ends
 * can give it up; one in the middle cannot, since dropping it would leave a
 * hole.
 *
 * Returns ids, because ids are what a selection holds.
 * @returns {Set<string>}
 */
export function mergeSelectable(session, selectedIds) {
  const ids = (session?.sentences || []).map((sentence) => sentence.id);
  const selected = new Set(selectedIds || []);
  if (!selected.size) return new Set(ids);

  const indices = ids.map((id, index) => (selected.has(id) ? index : -1)).filter((index) => index !== -1);
  const first = indices[0];
  const last = indices[indices.length - 1];

  return new Set([ids[first - 1], ids[first], ids[last], ids[last + 1]].filter(Boolean));
}

/**
 * The practice text a session should be saved with.
 *
 * For a typed session it is what the user typed. For one built from an audio
 * file there is no typed text, and the transcript is what the sentences
 * themselves say -- deriving it keeps the two from drifting apart as sentences
 * are split, merged and edited.
 */
export function derivedInputText(session) {
  if (session.splitMode !== 'audio') return session.inputText ?? '';
  return (session.sentences || []).map((s) => s.text).join('\n');
}

/** A one-line label for a session in a list: its name, else its opening words. */
export function sessionLabel(session, limit = 40) {
  if (session.name) return session.name;
  const text = (session.sentences || [])[0]?.text || derivedInputText(session) || '';
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return 'Untitled';
  const cs = chars(flat);
  return cs.length <= limit ? flat : `${cs.slice(0, limit).join('')}…`;
}
