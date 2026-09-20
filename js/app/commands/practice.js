// The practice loop for one sentence: hear it, record it, score it.
//
// All three follow the command shape -- snapshot, slow work, apply by id. None
// of them pins a version: each writes one field of one sentence, identified by
// id, so landing after the list has moved is fine as long as the sentence is
// still there. `updateSentence` returns the session untouched when it is not,
// which is exactly the right outcome for a result that arrived too late.
//
// Recorders are not stored on the sentence. They are held by the caller, keyed
// by id, and passed in: a lifecycle attached to a record has to be released by
// everything that ever replaces that record, which is how a sync ended up
// having to know that recorders exist.

import { updateSentence, sentenceById, setOnEverySentence } from '../../model/session.js';
import { localeOf } from '../../model/lang.js';
import { alignWordsToText } from '../../model/transcript.js';

const failure = (reason) => ({ ok: false, reason });

/**
 * Produce the reference reading for a sentence, unless it already has one.
 *
 * A sentence whose reference came from an imported file already holds the real
 * thing; synthesising over it would replace a recording of actual speech with
 * an imitation.
 */
export async function speak({ store, sentenceId, deps, force = false }) {
  const { speech, settings, player, clock, browserSpeech } = deps;

  const sentence = sentenceById(store.get(), sentenceId);
  if (!sentence) return failure('gone');

  if (sentence.reference && !force) {
    const played = await player.play(sentence.reference, sentenceId);
    return { ok: true, synthesized: false, played };
  }
  if (sentence.referenceSource === 'import' && !force) return failure('no-reference-audio');

  const locale = localeOf(sentence.lang);

  // No key: fall back to the browser's own voice, which is worth having --
  // practising against a flat reading beats practising against silence. It
  // produces no clip, so nothing is stored, nothing syncs, and scoring still
  // needs a key; the message says which voice was heard so that a reading that
  // sounds wrong is not mistaken for the service's.
  if (!settings.hasCredentials()) {
    if (!browserSpeech?.available()) return failure('no-credentials');
    player.stop();
    try {
      await browserSpeech.speak(sentence.text, locale);
    } catch (err) {
      return failure(err.message);
    }
    return {
      ok: true,
      synthesized: false,
      viaBrowser: true,
      message: "Read by the browser's own voice. Add an Azure key in Settings for a natural one.",
    };
  }

  let clip;
  try {
    clip = await speech().synthesize(sentence.text, locale, settings.voice(locale));
  } catch (err) {
    return failure(err.message);
  }

  store.apply((current) => updateSentence(current, sentenceId, {
    reference: clip,
    referenceHash: null, // stamped on save; a stale hash here would claim the old clip
    referenceSource: 'tts',
    // Whatever word timings this sentence had described a clip that is now
    // gone. Keeping them would leave the reading followed along the wrong
    // words and vocabulary cut from the wrong moments.
    words: null,
  }, clock()), 'speak');

  const played = await player.play(clip, sentenceId);

  // Learning where the words fall in the new clip takes another round trip, and
  // playback must not wait for it: the reading starts now, and the highlight
  // joins in when it can. Returned rather than dropped so a caller -- a test --
  // can wait for it; the panel ignores it.
  return { ok: true, synthesized: true, played, aligning: alignReference({ store, sentenceId, clip, deps }) };
}

/**
 * Recover word timings for a synthesized clip, by transcribing the reading back.
 *
 * Synthesis says nothing about where each word ended up, and that is what the
 * karaoke highlight, the exact cut markers and vocabulary clips are all made
 * of. Transcribing the clip is the only way to find out.
 *
 * Best-effort throughout: it needs the resource name that fast transcription
 * requires, which Speak itself does not, and a failure here must never disturb
 * a reading that is already playing. Every outcome is reported rather than
 * thrown, and nothing is written unless the sentence still holds the very clip
 * this ran on -- by the time it answers, the sentence may have been split,
 * merged, or spoken again.
 */
export async function alignReference({ store, sentenceId, clip, deps }) {
  const { speech, settings, clock } = deps;

  if (!settings.credentials()?.resourceName) return failure('no-resource-name');

  const sentence = sentenceById(store.get(), sentenceId);
  if (!sentence || sentence.reference !== clip) return failure('superseded');
  const text = sentence.text;
  const locale = localeOf(sentence.lang);

  let transcript;
  try {
    transcript = await speech().transcribe(clip, [locale]);
  } catch (err) {
    return failure(err.message);
  }

  const words = alignWordsToText(transcript.phrases, text);
  if (!words) return failure('no-words');

  const applied = store.apply((current) => {
    const now = sentenceById(current, sentenceId);
    if (!now || now.reference !== clip || now.text !== text) return null;
    return updateSentence(current, sentenceId, { words }, clock());
  }, 'align');

  return applied ? { ok: true, words: words.length } : failure('superseded');
}

/**
 * Begin recording a sentence.
 *
 * Playback is stopped first: recording what the speakers are playing is never
 * what is wanted, and the microphone would pick it up.
 */
export async function startRecording({ store, sentenceId, recorder, deps }) {
  const { player } = deps;
  if (!sentenceById(store.get(), sentenceId)) return failure('gone');

  player.stop();
  try {
    const started = await recorder.start();
    return started ? { ok: true } : failure('already-recording');
  } catch (err) {
    return failure(err.message);
  }
}

/**
 * Stop recording and keep the take.
 *
 * A take for a sentence that has since been split or merged away is dropped
 * rather than written somewhere else, and the caller is told, so a recording is
 * never silently attached to the wrong text.
 */
export async function stopRecording({ store, sentenceId, recorder, deps }) {
  const { clock } = deps;

  let take;
  try {
    take = await recorder.stop();
  } catch (err) {
    return failure(err.message);
  }
  if (!take) return failure('not-recording');

  const applied = store.apply((current) => updateSentence(current, sentenceId, {
    recording: take.blob,
    recordingHash: null,
    // A new take invalidates the score of the previous one. Keeping it would
    // show a number that describes audio nobody can play any more.
    assessment: null,
    assessmentHash: null,
  }, clock()), 'recording');

  if (!applied) return { ok: false, reason: 'gone', discarded: take };
  return { ok: true, durationMs: take.durationMs };
}

/**
 * Score a sentence's take against its text.
 *
 * The reference text is read from the session at the moment of the request, so
 * the score describes the sentence as it then read; if the sentence is edited
 * while the request is in flight, the result is discarded rather than shown
 * against text it was not scored against.
 */
export async function score({ store, sentenceId, deps }) {
  const { speech, settings, clock } = deps;

  const sentence = sentenceById(store.get(), sentenceId);
  if (!sentence) return failure('gone');
  if (!sentence.recording) return failure('no-recording');
  if (!settings.hasCredentials()) return failure('no-credentials');

  const scoredText = sentence.text;
  const recording = sentence.recording;

  let assessment;
  try {
    assessment = await speech().assess(recording, scoredText, localeOf(sentence.lang));
  } catch (err) {
    return failure(err.message);
  }

  let stale = false;
  const applied = store.apply((current) => {
    const now = sentenceById(current, sentenceId);
    if (!now) return null;
    if (now.text !== scoredText || now.recording !== recording) {
      // Scored against text or audio that is no longer what this sentence has.
      stale = true;
      return null;
    }
    return updateSentence(current, sentenceId, { assessment, assessmentHash: null }, clock());
  }, 'score');

  if (!applied) return failure(stale ? 'superseded' : 'gone');
  return { ok: true, assessment };
}

/** Hide or reveal a sentence's text, for practising from the audio alone. */
export function toggleHidden({ store, sentenceId, hidden, deps }) {
  const changed = store.apply((current) => updateSentence(current, sentenceId, { hidden }, deps.clock()), 'hidden');
  return { ok: changed };
}

/**
 * Hide or show every sentence at once, and remember it as the way this person
 * is practising.
 *
 * The preference is saved whether or not there is a session on screen, because
 * it governs the next one too -- sentences made from here on start hidden.
 */
export function setAllHidden({ store, hidden, deps }) {
  const { clock, settings } = deps;
  settings?.saveHideText(hidden);
  const changed = store.apply((current) => setOnEverySentence(current, { hidden }, clock()), 'hidden-all');
  return { ok: true, changed };
}

/**
 * Change a sentence's language.
 *
 * A synthesised reference is in the old language, so it is dropped: keeping it
 * would speak Japanese text in an English voice until something happened to
 * replace it. An imported reference is real audio of the sentence and stays
 * whatever language it was recorded in.
 */
export function setLanguage({ store, sentenceId, lang, deps }) {
  const changed = store.apply((current) => {
    const sentence = sentenceById(current, sentenceId);
    if (!sentence || sentence.lang === lang) return null;
    const dropsReference = sentence.referenceSource === 'tts';
    return updateSentence(current, sentenceId, {
      lang,
      ...(dropsReference ? { reference: null, referenceHash: null, referenceSource: null, words: null } : {}),
      assessment: null,
      assessmentHash: null,
    }, deps.clock());
  }, 'language');
  return { ok: changed };
}
