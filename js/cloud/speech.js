// The three Azure Speech endpoints this app uses: synthesis (the reference
// reading), pronunciation assessment (scoring a take), and fast transcription
// (importing an audio file).
//
// `speechClient(credentials)` binds them to one set of credentials, the same
// shape ./blob.js uses for the container: nothing here reads storage, so this
// layer needs no access to the browser and its tests need no mocking.
//
// This module is also the boundary where the vendor's representation stops.
// Responses are normalised on the way out -- 100-nanosecond ticks become
// milliseconds, locales become the app's own language codes, and scores are
// read from either of the two shapes Azure returns them in. Nothing downstream
// sees an Azure field name, which is what lets model/ describe timings once and
// have every producer agree.

import { langOfLocale, ALL_LOCALES } from '../model/lang.js';

const TRANSCRIPTION_API_VERSION = '2025-10-15';

/** Assessment audio must be exactly this, per the endpoint's own contract. */
const ASSESSMENT_CONTENT_TYPE = 'audio/wav; codecs=audio/pcm; samplerate=16000';

/** MP3 at 24 kHz: small enough to fetch quickly, good enough to imitate. */
const SYNTHESIS_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

/**
 * Turn a failed response into something a person can act on. Status alone is
 * not actionable here: 401 and 403 nearly always mean the key or region is
 * wrong, which is not what "Forbidden" suggests.
 */
async function failure(action, response) {
  if (response.status === 401 || response.status === 403) {
    return new Error(`${action} failed: the key or region was rejected (HTTP ${response.status}). Check your Azure credentials.`);
  }
  if (response.status === 429) {
    return new Error(`${action} failed: too many requests, or the quota is exhausted (HTTP 429). Try again later.`);
  }
  let detail = '';
  try { detail = (await response.text()).trim(); } catch { /* body is optional context */ }
  return new Error(`${action} failed: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
}

const networkFailure = (action) => new Error(`${action} failed: the request could not be sent. Check your connection and that the region is correct.`);

const escapeXml = (text) => String(text)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

/**
 * `xml:lang` belongs on `<speak>` only. A `<voice xml:lang=...>` is rejected
 * outright by the newer multilingual voices, which is not obvious from the
 * error they return.
 */
export function buildSsml(text, locale, voice) {
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">`
    + `<voice name="${voice}">${escapeXml(text)}</voice>`
    + '</speak>';
}

/** UTF-8 then base64, so non-ASCII reference text survives the header. */
export function toBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Azure times words in 100-nanosecond ticks. null, never 0, when absent: an
 *  omitted word has no audio at all, which is a different fact from "starts at
 *  the beginning". */
export function ticksToMs(ticks) {
  return typeof ticks === 'number' && Number.isFinite(ticks) ? ticks / 10_000 : null;
}

/** The first usable number among the candidates, since scores arrive either
 *  nested under PronunciationAssessment or flat on the object itself. */
function score(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'number' && !Number.isNaN(value)) return value;
  }
  return 0;
}

/**
 * Normalise an assessment response.
 *
 * Throws when nothing was recognised -- silence, a mistimed recording, a
 * reading of something else -- with the reason, because that is a normal thing
 * for a person to do and the fix is theirs to make.
 */
export function parseAssessment(json) {
  const status = json?.RecognitionStatus;
  if (status !== 'Success') {
    throw new Error(`No speech was recognised (${status || 'unknown status'}). Read the whole sentence, closer to the microphone, and score again.`);
  }
  const best = json.NBest?.[0];
  if (!best) throw new Error('The scoring service returned no result. Try again.');

  const assessment = best.PronunciationAssessment || {};
  return {
    displayText: best.Display || json.DisplayText || '',
    overall: {
      accuracy: score(assessment.AccuracyScore, best.AccuracyScore),
      fluency: score(assessment.FluencyScore, best.FluencyScore),
      completeness: score(assessment.CompletenessScore, best.CompletenessScore),
      pronunciation: score(assessment.PronScore, best.PronScore),
    },
    words: (best.Words || []).map((word) => {
      const wordAssessment = word.PronunciationAssessment || {};
      return {
        word: word.Word || '',
        accuracy: score(wordAssessment.AccuracyScore, word.AccuracyScore),
        errorType: wordAssessment.ErrorType || word.ErrorType || 'None',
        // Positions in the recording, so a single word's audio can be replayed.
        offsetMs: ticksToMs(word.Offset),
        durationMs: ticksToMs(word.Duration),
        phonemes: (word.Phonemes || [])
          .map((phoneme) => ({
            phoneme: phoneme.Phoneme || '',
            accuracy: score(phoneme.PronunciationAssessment?.AccuracyScore, phoneme.AccuracyScore),
          }))
          // Japanese comes back with empty phoneme names; an unnamed phoneme
          // score cannot be shown against anything.
          .filter((phoneme) => phoneme.phoneme),
      };
    }),
  };
}

/**
 * Normalise a transcription response into the shape model/transcript.js
 * re-segments: app language codes, milliseconds, and no vendor field names.
 */
export function normalizeTranscript(json) {
  const phrases = (json?.phrases || []).map((phrase) => ({
    text: phrase.text || '',
    lang: langOfLocale(phrase.locale),
    offsetMs: phrase.offsetMilliseconds ?? null,
    durationMs: phrase.durationMilliseconds ?? null,
    words: (phrase.words || []).map((word) => ({
      text: word.text || '',
      offsetMs: word.offsetMilliseconds ?? null,
      durationMs: word.durationMilliseconds ?? null,
    })),
  }));
  return { phrases, durationMs: json?.durationMilliseconds ?? null };
}

/**
 * @typedef {object} Credentials
 * @property {string} key
 * @property {string} region       For synthesis and assessment.
 * @property {string} [resourceName] For transcription, which is addressed by resource rather than region.
 */

/**
 * @param {Credentials} credentials
 */
export function speechClient(credentials) {
  const { key, region, resourceName } = credentials || {};

  const post = async (action, url, { headers = {}, body }) => {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': key, ...headers },
        body,
      });
    } catch {
      throw networkFailure(action);
    }
    if (!response.ok) throw await failure(action, response);
    return response;
  };

  return {
    /** The reference reading of `text`, as an audio Blob. */
    async synthesize(text, locale, voice) {
      const response = await post('Speech synthesis', `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        headers: {
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': SYNTHESIS_FORMAT,
        },
        body: buildSsml(text, locale, voice),
      });
      return response.blob();
    },

    /**
     * Score a take against the sentence it was meant to be.
     *
     * `wavBlob` must be 16 kHz mono PCM WAV -- the endpoint accepts nothing
     * else, which is why platform/audio.js encodes to exactly that.
     */
    async assess(wavBlob, referenceText, locale) {
      const config = {
        ReferenceText: referenceText,
        GradingSystem: 'HundredMark',
        Granularity: 'Phoneme',
        Dimension: 'Comprehensive',
        // Counts words read that are not in the reference, and words skipped,
        // rather than scoring only what happened to be said.
        EnableMiscue: true,
      };
      const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`
        + `?language=${encodeURIComponent(locale)}&format=detailed`;

      const response = await post('Pronunciation scoring', url, {
        headers: {
          'Content-Type': ASSESSMENT_CONTENT_TYPE,
          'Pronunciation-Assessment': toBase64Utf8(JSON.stringify(config)),
          Accept: 'application/json',
        },
        body: wavBlob,
      });
      return parseAssessment(await response.json());
    },

    /** Transcribe a file, with word-level timings where the service provides them. */
    async transcribe(file, locales = ALL_LOCALES) {
      const url = `https://${resourceName}.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe`
        + `?api-version=${TRANSCRIPTION_API_VERSION}`;

      const form = new FormData();
      form.append('audio', file);
      form.append('definition', JSON.stringify({ locales }));

      // No Content-Type header: fetch sets it, including the multipart boundary,
      // which cannot be written by hand.
      const response = await post('Transcription', url, { body: form });
      return normalizeTranscript(await response.json());
    },
  };
}
