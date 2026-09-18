// Splitting and merging the sentence on screen.
//
// Both follow the same three steps, and the order matters: read a snapshot,
// do the slow work (cutting audio out of the source file), then apply the
// result to whatever the session is by then -- pinned to the version the
// snapshot came from, so a result computed against a session that has since
// changed is dropped instead of overwriting the change.
//
// Audio is cut here rather than in model/, because cutting it needs the
// browser's decoder. When a cut is not possible the text operation still
// happens and the caller is told the audio could not follow: the split is what
// the user asked for, and silently keeping a hash that points at a clip which
// was never made is how content goes missing.

import { splitSentence, mergeSentences, sentenceById, canMerge } from '../../model/session.js';
import { splitRange, mergeRanges } from '../../model/geometry.js';

/** What a command tells its caller: whether it happened, and anything worth saying. */
const result = (ok, over = {}) => ({ ok, reason: null, audioFollowed: null, ...over });

/**
 * Cut a session's source audio into the ranges given, returning a clip and its
 * hash per range, or null when there is nothing to cut from.
 */
async function cutReferences(session, ranges, { audio, hash }) {
  if (!session.sourceAudio || ranges.some((range) => range == null)) return null;

  let decoded;
  try {
    decoded = await audio.decode(session.sourceAudio);
  } catch {
    // An undecodable source is not worth failing the split over; the text
    // operation is still what was asked for.
    return null;
  }

  const clips = ranges.map((range) => audio.cutClip(decoded, range));
  if (clips.some((clip) => clip == null)) return null;
  return Promise.all(clips.map(async (clip) => ({ blob: clip, hash: await hash.hashBlob(clip) })));
}

/**
 * Split the sentence `sentenceId` at `charIndex`.
 *
 * `ms` is the position's timestamp on the source timeline, or null where the
 * position has none -- a cut offered from the text rather than from a real word
 * boundary. Null means the audio cannot be divided there, which is a normal
 * outcome reported as `audioFollowed: false`, not an error.
 */
export async function splitAtPointer({ store, sentenceId, charIndex, ms, deps }) {
  const { audio, hash, ids, clock, tombstone } = deps;

  const startedAt = store.version();
  const session = store.get();
  if (!session) return result(false, { reason: 'no-session' });

  const sentence = sentenceById(session, sentenceId);
  if (!sentence) return result(false, { reason: 'gone' });

  const wholeRange = sentence.sourceOffsetMs != null && sentence.sourceDurationMs != null
    ? { offsetMs: sentence.sourceOffsetMs, durationMs: sentence.sourceDurationMs }
    : null;
  const halves = sentence.referenceSource === 'import' && wholeRange ? splitRange(wholeRange, ms) : null;

  const clips = halves ? await cutReferences(session, [halves.left, halves.right], { audio, hash }) : null;

  const leftId = ids();
  const rightId = ids();
  const now = clock();

  const applied = store.applyIfUnchanged(startedAt, (current) => splitSentence(current, {
    sentenceId,
    charIndex,
    leftId,
    rightId,
    now,
    left: clips ? { reference: clips[0].blob, referenceHash: clips[0].hash, range: halves.left } : {},
    right: clips ? { reference: clips[1].blob, referenceHash: clips[1].hash, range: halves.right } : {},
  })?.session ?? null);

  if (!applied) {
    // Either the cut was refused (a whitespace-only half) or the session moved
    // while the audio was being cut. Both mean: nothing happened, try again
    // against what is there now.
    return result(false, { reason: store.version() === startedAt ? 'refused' : 'superseded' });
  }

  // The sentence this replaced must be tombstoned, or a device that has not
  // seen the split yet brings it back alongside its own replacements.
  await tombstone([sentenceId]);

  return result(true, {
    audioFollowed: sentence.referenceSource === 'import' ? Boolean(clips) : null,
    added: [leftId, rightId],
  });
}

/**
 * Merge a run of adjacent sentences into one.
 *
 * The merged clip is cut fresh from the source file rather than joining the
 * existing clips, so repeated splits and merges never compound resampling and
 * normalisation error.
 */
export async function mergeSelected({ store, sentenceIds, deps }) {
  const { audio, hash, ids, clock, tombstone } = deps;

  const startedAt = store.version();
  const session = store.get();
  if (!session) return result(false, { reason: 'no-session' });
  if (!canMerge(session, sentenceIds)) return result(false, { reason: 'not-adjacent' });

  const run = sentenceIds
    .map((id) => sentenceById(session, id))
    .sort((a, b) => (a.sourceOffsetMs ?? 0) - (b.sourceOffsetMs ?? 0));

  const ranges = run.map((s) => (
    s.sourceOffsetMs != null && s.sourceDurationMs != null
      ? { offsetMs: s.sourceOffsetMs, durationMs: s.sourceDurationMs }
      : null
  ));
  const wholeRange = run.every((s) => s.referenceSource === 'import') ? mergeRanges(ranges) : null;
  const clips = wholeRange ? await cutReferences(session, [wholeRange], { audio, hash }) : null;

  const newId = ids();
  const now = clock();

  const applied = store.applyIfUnchanged(startedAt, (current) => mergeSentences(current, {
    sentenceIds,
    newId,
    now,
    reference: clips ? clips[0].blob : null,
    referenceHash: clips ? clips[0].hash : null,
    range: wholeRange,
  })?.session ?? null);

  if (!applied) {
    return result(false, { reason: store.version() === startedAt ? 'refused' : 'superseded' });
  }

  await tombstone(sentenceIds);

  return result(true, {
    audioFollowed: run.every((s) => s.referenceSource === 'import') ? Boolean(clips) : null,
    added: [newId],
  });
}
