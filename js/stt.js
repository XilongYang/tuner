// Azure Fast Transcription: the speech-to-text counterpart to tts.js's
// synthesizeAzure() and pron.js's assessPronunciation() -- all three are thin
// wrappers around one specific Azure Speech REST endpoint, called directly
// from the browser with no backend in between.
//
// Used by two independent callers for two different reasons: sentence-panel's
// audio-import flow (via split-actions.js's handleAudioImport()) transcribes
// a user-supplied file to build a new session from it; tts-player.js's
// alignWordsForClip() re-transcribes a synthesized TTS clip to recover real
// word-level timestamps for it. Neither caller is specific to the other, so
// this lives here rather than inside sentence-panel -- a generic Azure API
// wrapper has no business importing from, or being imported by, one
// particular feature's business module.

const API_VERSION = '2025-10-15';

/** Send `file` to Azure Fast Transcription and return the parsed JSON result
 *  (phrases with locale/text/offsetMilliseconds/durationMilliseconds/words). */
export async function transcribe(file, creds) {
  const endpoint = `https://${creds.resourceName}.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=${API_VERSION}`;
  const form = new FormData();
  form.append('audio', file);
  form.append('definition', JSON.stringify({ locales: ['ja-JP', 'en-US'] }));
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': creds.key },
    body: form,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Azure returned HTTP ${resp.status}${text ? `: ${text}` : ''}`);
  }
  return resp.json();
}
