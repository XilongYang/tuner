// 文本转语音（TTS）。
// 主方案：Azure Cognitive Services TTS REST API（Neural 语音）。
// 降级方案：浏览器自带 speechSynthesis（无 Key 时使用，质量较低）。

import { loadCredentials, DEFAULT_VOICES } from './config.js';

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
  return `<speak version="1.0" xml:lang="${locale}">` +
    `<voice xml:lang="${locale}" name="${voice}">${escapeXml(text)}</voice>` +
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
  if (!creds) throw new Error('未配置 Azure 凭据');

  const voice = DEFAULT_VOICES[locale] || DEFAULT_VOICES['en-US'];
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
    throw new Error('网络请求失败，请检查网络连接或 Region 是否正确');
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Key 无效或无权限（401/403），请检查你的 Key 和 Region');
    }
    if (response.status === 429) {
      throw new Error('请求过于频繁或超出配额（429），请稍后再试');
    }
    throw new Error(`TTS 请求失败：HTTP ${response.status}`);
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
      reject(new Error('当前浏览器不支持内置语音合成'));
      return;
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = locale;
    utter.onend = () => resolve();
    utter.onerror = () => reject(new Error('内置语音合成失败'));
    window.speechSynthesis.speak(utter);
  });
}
