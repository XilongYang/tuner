// Pronunciation Assessment.
// Calls Azure Speech-to-Text's short-audio REST endpoint directly, passing
// assessment parameters via the Pronunciation-Assessment header. Zero third-party
// dependencies; requests go straight from the browser to Azure.
//
// Endpoint contract (official Azure):
//   POST https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1
//   ?language={locale}&format=detailed
//   Header: Ocp-Apim-Subscription-Key, Content-Type: audio/wav; codecs=audio/pcm; samplerate=16000
//   Header: Pronunciation-Assessment: base64(UTF-8 JSON config)
//   Body: WAV audio (16kHz/16bit/mono)

import { loadCredentials } from './config.js';

/** Encode a string as UTF-8 then base64 (supports non-ASCII reference text like Japanese). */
function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Assess the pronunciation of a recording.
 * @param {Blob} wavBlob      16kHz/16bit/mono WAV
 * @param {string} referenceText  reference text (the target sentence being read)
 * @param {string} locale     e.g. 'ja-JP' / 'en-US'
 * @returns {Promise<object>} normalized assessment result, see parseResult
 */
export async function assessPronunciation(wavBlob, referenceText, locale) {
  const creds = loadCredentials();
  if (!creds) throw new Error('Pronunciation scoring requires Azure credentials. Add your Key and Region under Azure settings first.');

  const config = {
    ReferenceText: referenceText,
    GradingSystem: 'HundredMark',
    Granularity: 'Phoneme',
    Dimension: 'Comprehensive',
    EnableMiscue: true,
  };
  const header = toBase64Utf8(JSON.stringify(config));

  const endpoint =
    `https://${creds.region}.stt.speech.microsoft.com` +
    `/speech/recognition/conversation/cognitiveservices/v1` +
    `?language=${encodeURIComponent(locale)}&format=detailed`;

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': creds.key,
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        'Pronunciation-Assessment': header,
        'Accept': 'application/json',
      },
      body: wavBlob,
    });
  } catch (networkErr) {
    throw new Error('Network request failed. Check your connection or that the Region is correct.');
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Invalid key or no permission (401/403). Check your Key and Region.');
    }
    if (response.status === 429) {
      throw new Error('Too many requests or quota exceeded (429). Try again later.');
    }
    throw new Error(`Scoring request failed: HTTP ${response.status}`);
  }

  const json = await response.json();
  return parseResult(json);
}

/**
 * Normalize the raw Azure response into a render-friendly structure.
 * @returns {{
 *   status: string,
 *   displayText: string,
 *   overall: { accuracy: number, fluency: number, completeness: number, pron: number } | null,
 *   words: Array<{ word: string, accuracy: number, errorType: string, phonemes: Array<{ phoneme: string, accuracy: number }> }>
 * }}
 */
export function parseResult(json) {
  const status = json && json.RecognitionStatus;
  if (status !== 'Success') {
    // Common: NoMatch (no speech detected), InitialSilenceTimeout, etc.
    throw new Error(`No valid speech recognized (${status || 'unknown status'}). Move closer to the mic, read the full sentence, then score again.`);
  }

  const best = json.NBest && json.NBest[0];
  if (!best) throw new Error('Empty result. Please try again.');

  // Azure returns two shapes:
  //   1. scores nested under a PronunciationAssessment sub-object (newer detailed format)
  //   2. scores flat on the object itself (common on the conversation endpoint)
  // Support both: read the nested field first, fall back to the flat field.
  const bpa = best.PronunciationAssessment || {};
  const overall = {
    accuracy: pickScore(bpa.AccuracyScore, best.AccuracyScore),
    fluency: pickScore(bpa.FluencyScore, best.FluencyScore),
    completeness: pickScore(bpa.CompletenessScore, best.CompletenessScore),
    pron: pickScore(bpa.PronScore, best.PronScore),
  };

  const words = (best.Words || []).map((w) => {
    const wpa = w.PronunciationAssessment || {};
    return {
      word: w.Word || '',
      accuracy: pickScore(wpa.AccuracyScore, w.AccuracyScore),
      errorType: wpa.ErrorType || w.ErrorType || 'None',
      phonemes: (w.Phonemes || [])
        .map((p) => {
          const ppa = p.PronunciationAssessment || {};
          return {
            phoneme: p.Phoneme || '',
            accuracy: pickScore(ppa.AccuracyScore, p.AccuracyScore),
          };
        })
        // Some languages (e.g. Japanese) return empty phoneme names; drop those
        .filter((p) => p.phoneme),
    };
  });

  return {
    status,
    displayText: best.Display || json.DisplayText || '',
    overall,
    words,
  };
}

/** Return the first valid number among candidates (to support nested/flat layouts). */
function pickScore(...values) {
  for (const v of values) {
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
  }
  return 0;
}
