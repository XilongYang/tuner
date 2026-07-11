// 文本转语音（TTS）。
// 主方案：Azure Cognitive Services TTS REST API（Neural 语音）。
// 降级方案：浏览器自带 speechSynthesis（无 Key 时使用，质量较低）。

import { loadCredentials, getVoice } from './config.js';

/** 转义 SSML 中的 XML 特殊字符。 */
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSsml(text, locale, voice) {
  // 标准 Azure SSML：xml:lang 只放在 <speak> 上，<voice> 只带 name。
  // （非标准的 <voice xml:lang> 会被较新的多语言音色严格校验拒绝，返回 400。）
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">` +
    `<voice name="${voice}">${escapeXml(text)}</voice>` +
    `</speak>`;
}

/**
 * 用 Azure REST API 合成语音，返回音频 Blob。
 * @param {string} text
 * @param {string} locale  例如 'ja-JP' / 'en-US'
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
    try { detail = (await response.text()).trim(); } catch { /* 忽略 */ }
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
 * 用浏览器自带 speechSynthesis 朗读（降级方案，不产生 Blob）。
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
