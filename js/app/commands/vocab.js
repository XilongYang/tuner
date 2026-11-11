// The vocabulary library: words and phrases noticed while practising, each
// accumulating the occasions it came up.
//
// One entry per normalised text, with a list of occurrences. An occurrence is
// an append-only fact -- it happened, on some date, in some sentence -- which
// is why two devices' lists are unioned rather than one replacing the other,
// and why an occurrence keeps a snapshot of the sentence it came from: the
// session it was recorded in may since have been edited or deleted, and the
// occurrence is still meaningful without it.

import { vocabKey, occurrenceKey } from '../../model/text.js';
import { sentenceById } from '../../model/session.js';
import { chars } from '../../model/geometry.js';
import { localeOf } from '../../model/lang.js';
import { startsHidden } from './session.js';

const failure = (reason) => ({ ok: false, reason });

/**
 * A standalone clip of just this word, for replaying it on its own.
 *
 * Cut from the session's source file when the word's own timings are known,
 * otherwise synthesised. Returns null when neither is possible, which is a
 * normal outcome: a text-only occurrence is still worth keeping.
 */
async function resolveAudio({ session, sentence, range, text, deps }) {
  const { audio, speech, settings } = deps;

  if (sentence.referenceSource === 'import' && session.sourceAudio && range) {
    try {
      const decoded = await audio.decode(session.sourceAudio);
      const clip = audio.cutClip(decoded, range);
      if (clip) return clip;
    } catch {
      // Fall through to synthesis: an undecodable source is not a reason to
      // refuse the entry.
    }
  }

  if (!settings.hasCredentials()) return null;
  try {
    const locale = localeOf(sentence.lang);
    return await speech().synthesize(text, locale, settings.voice(locale));
  } catch {
    return null;
  }
}

/**
 * The range a run of words occupies, on the source timeline.
 *
 * Built from the first and last word's own timings; null when either is
 * missing, since a range covering only part of the phrase would cut the wrong
 * audio.
 */
export function rangeOfWords(words) {
  if (!words?.length) return null;
  const first = words[0];
  const last = words[words.length - 1];
  if (first.offsetMs == null || last.offsetMs == null || last.durationMs == null) return null;
  const durationMs = (last.offsetMs + last.durationMs) - first.offsetMs;
  if (!(durationMs > 0)) return null;
  return { offsetMs: first.offsetMs, durationMs };
}

/**
 * Record one occurrence of `words` from a sentence.
 *
 * `words` is a contiguous run of that sentence's own word entries. The entry is
 * created on first sight of the text and appended to on every later one.
 */
export async function addOccurrence({ store, sentenceId, words, deps }) {
  const { db, hash, clock, saveRecord, settings } = deps;

  const session = store.get();
  const sentence = session && sentenceById(session, sentenceId);
  if (!sentence) return failure('gone');
  if (!words?.length) return failure('no-selection');

  // In characters, as every word position is (see model/geometry.js): a
  // UTF-16 slice is one position out for every astral character before the
  // word, and stores a different word from the one the picker showed.
  const text = chars(sentence.text).slice(words[0].charStart, words[words.length - 1].charEnd).join('');
  const id = vocabKey(text);
  if (!id) return failure('not-a-word');

  const range = rangeOfWords(words);
  const clip = await resolveAudio({ session, sentence, range, text, deps });

  const now = clock();
  const occurrence = {
    // Keyed by where it came from, not by when it was noticed: see
    // occurrenceKey. The same word picked from the same sentence twice is one
    // use of it, and is refreshed rather than repeated.
    occurrenceId: occurrenceKey(session.id, sentenceId),
    sessionId: session.id,
    sentenceId,
    // Kept so the occurrence still reads correctly after the sentence it came
    // from is edited, split away or deleted.
    sentenceTextSnapshot: sentence.text,
    addedAt: now,
    audio: clip,
    audioHash: null,
  };

  const existing = await db.getOne('vocab', id);
  const entry = existing
    ? {
      ...existing,
      updatedAt: now,
      sources: [
        ...(existing.sources || []).filter((source) => source.occurrenceId !== occurrence.occurrenceId),
        occurrence,
      ],
    }
    : {
      id,
      text,
      lang: sentence.lang,
      // A word collected while practising from memory starts covered, the same
      // way a sentence split while the switch is on does. Otherwise the next
      // word added would be the one thing on the page giving the answer away.
      hidden: startsHidden(settings),
      // Derived once from the id and never recomputed: it is the folder every
      // occurrence's audio lives under, and changing it would strand all of it.
      audioPathKey: await hash.hashString(id),
      createdAt: now,
      updatedAt: now,
      sources: [occurrence],
    };

  const stored = await saveRecord('vocab', entry, { db, hash, previous: existing });
  return { ok: true, id, created: !existing, occurrences: stored.sources.length };
}

/**
 * Record several picked phrases from one sentence.
 *
 * `groups` is what the picker chose: each group a contiguous run of that
 * sentence's word units, each becoming its own entry.
 *
 * Stops at the first failure and says how many went in, and the caller retries
 * with `groups.slice(added)` -- see the picker, which keeps the count across
 * attempts and freezes the selection so the groups cannot change underneath it.
 *
 * Re-sending a group that already went in would not duplicate it: an
 * occurrence is keyed by where it came from, so the same words from the same
 * sentence are one use of it either way (see `addOccurrence`). Continuing from
 * where it stopped is still what the caller should do -- it is the difference
 * between one failed request and a dozen -- but a retry that starts over is a
 * waste rather than a corruption.
 *
 * @returns {Promise<{ok: boolean, added: number, reason: string|null, ids: string[]}>}
 */
export async function addOccurrences({ store, sentenceId, groups, deps }) {
  if (!groups?.length) return { ok: false, added: 0, reason: 'no-selection', ids: [] };

  const ids = [];
  for (const words of groups) {
    const outcome = await addOccurrence({ store, sentenceId, words, deps });
    if (!outcome.ok) return { ok: false, added: ids.length, reason: outcome.reason, ids };
    ids.push(outcome.id);
  }
  return { ok: true, added: ids.length, reason: null, ids };
}

/**
 * The range for a selection made inside a sentence whose reference is a slice
 * of a larger file.
 *
 * Exposed so a caller can tell in advance whether a selection will get real
 * audio or a synthesised imitation.
 */
export function selectionHasRealAudio(sentence, words) {
  if (sentence?.referenceSource !== 'import') return false;
  const range = rangeOfWords(words);
  if (!range || sentence.sourceOffsetMs == null || sentence.sourceDurationMs == null) return false;
  // The selection must fall inside the sentence's own slice of the file.
  const sentenceEnd = sentence.sourceOffsetMs + sentence.sourceDurationMs;
  return range.offsetMs >= sentence.sourceOffsetMs && (range.offsetMs + range.durationMs) <= sentenceEnd;
}

/**
 * Every entry, newest first -- the order the library is read in.
 *
 * By when it was collected, which never changes, and not by when it was last
 * written. `updatedAt` moves on every edit, so covering a word or meeting it in
 * a second sentence made it jump to the top of the list -- the row the user was
 * looking at, moving because they pressed a button on it. The id breaks a tie,
 * so two entries collected in the same millisecond (a picker adding several
 * words at once does exactly that) are at least in the same order on every
 * device.
 */
export async function list({ deps }) {
  const entries = await deps.db.listAll('vocab');
  return [...entries].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)
    || String(a.id).localeCompare(String(b.id)));
}

/**
 * Cover or uncover one entry's text.
 *
 * The stored field, not a view state: whether a word is covered survives a
 * reload and a sync, the same as it does for a sentence. A momentary peek is
 * still a click on the word itself, which changes nothing.
 */
export async function setHidden({ id, hidden, deps }) {
  const { db, clock } = deps;
  const entry = await db.getOne('vocab', id);
  if (!entry) return failure('gone');
  if (Boolean(entry.hidden) === hidden) return { ok: true, changed: false };

  await db.put('vocab', { ...entry, hidden, updatedAt: clock() });
  return { ok: true, changed: true };
}

/**
 * Cover or uncover every entry at once, for the header's switch.
 *
 * One transaction, and only the entries that disagree with it are rewritten --
 * a switch flipped twice should not make every word in the library look edited
 * to the next sync.
 */
export async function setAllHidden({ hidden, deps }) {
  const { db, clock } = deps;
  const entries = await db.listAll('vocab', { content: false });
  const changed = entries.filter((entry) => Boolean(entry.hidden) !== hidden);
  if (!changed.length) return { ok: true, changed: 0 };

  const now = clock();
  await db.putMany('vocab', changed.map((entry) => ({ ...entry, hidden, updatedAt: now })));
  return { ok: true, changed: changed.length };
}

/**
 * Delete an entry and every occurrence with it.
 *
 * The record and its tombstone are written together by the database, so the
 * deletion cannot be local-only and return on the next sync.
 */
export async function removeEntry({ id, deps }) {
  await deps.db.remove('vocab', id);
  return { ok: true };
}

/**
 * The audio to play for an entry: one of its occurrences, chosen at random.
 *
 * Random rather than the newest, so a word met in several sentences is heard in
 * all of them over time rather than always the same one.
 */
export function pickOccurrenceAudio(entry, random = Math.random) {
  const withAudio = (entry?.sources || []).filter((source) => source.audio);
  if (!withAudio.length) return null;
  return withAudio[Math.floor(random() * withAudio.length)];
}

/**
 * The reference audio of the sentence an occurrence came from, for hearing the
 * word in context.
 *
 * Returns null when that sentence is gone or has no reference audio -- both
 * ordinary, since the occurrence long outlives the session it was taken from.
 */
export async function sourceSentenceAudio({ occurrence, deps }) {
  if (!occurrence?.sessionId || !occurrence?.sentenceId) return null;
  const session = await deps.db.getOne('sessions', occurrence.sessionId);
  if (!session) return null;
  const sentence = (session.sentences || []).find((s) => s.id === occurrence.sentenceId);
  // Deliberately the reference, never the user's own take: the point is to hear
  // how the sentence should sound.
  return sentence?.reference ?? null;
}
