// Text-to-speech (TTS).
// Primary: Azure Cognitive Services TTS REST API (Neural voices).
// Fallback: the browser's built-in speechSynthesis (used without a key; lower quality).

import { loadCredentials, getVoice } from './config.js';

/** Escape XML special characters in SSML. */
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSsml(text, locale, voice) {
  // Standard Azure SSML: xml:lang goes on <speak> only, <voice> carries just name.
  // (A non-standard <voice xml:lang> is rejected by newer multilingual voices with 400.)
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">` +
    `<voice name="${voice}">${escapeXml(text)}</voice>` +
    `</speak>`;
}

/**
 * Synthesize speech via the Azure REST API, returning an audio Blob.
 * @param {string} text
 * @param {string} locale  e.g. 'ja-JP' / 'en-US'
 * @returns {Promise<Blob>}
 */
export async function synthesizeAzure(text, locale) {
  const creds = loadCredentials();
  if (!creds) throw new Error('Azure credentials not configured');

  const voice = getVoice(locale);
  const endpoint =
    `https://${creds.region}.tts.speech.microsoft.com/cognitiveservices/v1`;

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': creds.key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'speak-open-tool',
      },
      body: buildSsml(text, locale, voice),
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
    let detail = '';
    try { detail = (await response.text()).trim(); } catch { /* ignore */ }
    const extra = detail ? ` — ${detail.slice(0, 300)}` : '';
    if (response.status === 400) {
      throw new Error(
        `TTS bad request (400) for voice "${voice}" in region "${creds.region}"${extra}. ` +
        `Check the voice name is correct and available in that region.`);
    }
    throw new Error(`TTS request failed: HTTP ${response.status} (voice "${voice}", region "${creds.region}")${extra}`);
  }

  return await response.blob();
}

/**
 * Speak using the browser's built-in speechSynthesis (fallback; produces no Blob).
 * @param {string} text
 * @param {string} locale
 * @returns {Promise<void>}
 */
export function speakWithBrowser(text, locale) {
  return new Promise((resolve, reject) => {
    if (!('speechSynthesis' in window)) {
      reject(new Error('This browser does not support built-in speech synthesis'));
      return;
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = locale;
    utter.onend = () => resolve();
    utter.onerror = () => reject(new Error('Built-in speech synthesis failed'));
    window.speechSynthesis.speak(utter);
  });
}
