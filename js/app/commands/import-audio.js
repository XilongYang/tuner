// Building a session from an audio file: transcribe it, re-segment the
// transcript by punctuation, and cut one reference clip per sentence.
//
// Every clip is cut from the original file, which the session keeps, so a later
// split or merge can re-cut from the same pristine source rather than resampling
// an already-derived clip. That is the whole reason the file is stored at all.

import { resegment } from '../../model/transcript.js';
import { blankSentence } from '../../model/session.js';
import { langOfLocale } from '../../model/lang.js';
import { emptySession } from './session.js';

const failure = (reason) => ({ ok: false, reason });

/**
 * Sentences from a transcription that carried no usable word timings.
 *
 * The service's own pause-based boundaries segment worse than punctuation does,
 * but they do carry ranges, so the session is still usable -- just without
 * word-level cut points inside each sentence.
 */
function fromPhrases(phrases) {
  return (phrases || [])
    .filter((phrase) => phrase.text?.trim() && phrase.offsetMs != null && phrase.durationMs != null)
    .map((phrase) => ({
      text: phrase.text.trim(),
      lang: phrase.lang ?? langOfLocale(phrase.locale),
      offsetMs: phrase.offsetMs,
      durationMs: phrase.durationMs,
      words: [],
    }));
}

/**
 * Import `file` as a new session on screen.
 *
 * `onProgress` is called with each stage, because this takes long enough that
 * silence reads as a hang: a transcription is a round-trip over the whole file,
 * and decoding and cutting follow it.
 */
export async function importAudio({ store, file, deps, onProgress = () => {} }) {
  const { speech, settings, audio, hash, ids, clock, release, autosave } = deps;

  if (!settings.hasCredentials()) return failure('no-credentials');
  const credentials = settings.credentials();
  if (!credentials.resourceName) return failure('no-resource-name');

  onProgress({ stage: 'transcribing' });
  let transcript;
  try {
    transcript = await speech().transcribe(file);
  } catch (err) {
    return failure(err.message);
  }
  if (!transcript.phrases.length) return failure('no-speech');

  onProgress({ stage: 'segmenting' });
  const segments = resegment(transcript.phrases, transcript.durationMs);
  const parts = segments.length ? segments : fromPhrases(transcript.phrases);
  if (!parts.length) return failure('no-speech');

  onProgress({ stage: 'decoding' });
  let decoded;
  try {
    decoded = await audio.decode(file);
  } catch (err) {
    return failure(`could not decode the audio: ${err.message}`);
  }

  onProgress({ stage: 'cutting', total: parts.length });
  const now = clock();
  const sentences = [];
  for (const [index, part] of parts.entries()) {
    const clip = audio.cutClip(decoded, { offsetMs: part.offsetMs, durationMs: part.durationMs });
    sentences.push(blankSentence({
      id: ids(),
      text: part.text,
      lang: part.lang,
      now,
      words: part.words?.length ? part.words : null,
      // A sentence whose clip could not be cut keeps no reference and no source
      // markers, rather than claiming audio that does not exist.
      reference: clip,
      referenceSource: clip ? 'import' : null,
      sourceOffsetMs: clip ? part.offsetMs : null,
      sourceDurationMs: clip ? part.durationMs : null,
    }));
    onProgress({ stage: 'cutting', done: index + 1, total: parts.length });
  }

  release?.();
  const session = {
    ...emptySession({ id: ids(), now, splitMode: 'audio' }),
    // The original file, kept so later splits and merges re-cut from it.
    sourceAudio: file,
    sourceAudioHash: await hash.hashBlob(file),
    // Derived rather than typed: an imported session has no typed text, and the
    // transcript is what its sentences say.
    inputText: sentences.map((s) => s.text).join('\n'),
    sentences,
  };

  autosave?.reset(null);
  store.replace(session, 'imported');

  return {
    ok: true,
    count: sentences.length,
    withAudio: sentences.filter((s) => s.reference).length,
    fromWordTimings: segments.length > 0,
  };
}
