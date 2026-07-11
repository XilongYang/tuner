// 发音评估（Pronunciation Assessment）。
// 直连 Azure Speech-to-Text 的 REST 短音频接口，通过 Pronunciation-Assessment 请求头
// 传入评估参数。零第三方依赖，请求从浏览器直接发往 Azure。
//
// 接口约定（Azure 官方）：
//   POST https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1
//   ?language={locale}&format=detailed
//   Header: Ocp-Apim-Subscription-Key, Content-Type: audio/wav; codecs=audio/pcm; samplerate=16000
//   Header: Pronunciation-Assessment: base64(UTF-8 JSON 配置)
//   Body: WAV 音频（16kHz/16bit/单声道）

import { loadCredentials } from './config.js';

/** 将字符串按 UTF-8 编码后转 base64（支持日文等非 ASCII 参考文本）。 */
function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * 对一段录音做发音评估。
 * @param {Blob} wavBlob      16kHz/16bit/单声道 WAV
 * @param {string} referenceText  参考文本（朗读的目标句子）
 * @param {string} locale     例如 'ja-JP' / 'en-US'
 * @returns {Promise<object>} 归一化后的评估结果，见 parseResult
 */
export async function assessPronunciation(wavBlob, referenceText, locale) {
  const creds = loadCredentials();
  if (!creds) throw new Error('发音评估需要 Azure 凭据，请先在「Azure 设置」中填入 Key 和 Region');

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
    throw new Error('网络请求失败，请检查网络连接或 Region 是否正确');
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Key 无效或无权限（401/403），请检查你的 Key 和 Region');
    }
    if (response.status === 429) {
      throw new Error('请求过于频繁或超出配额（429），请稍后再试');
    }
    throw new Error(`发音评估请求失败：HTTP ${response.status}`);
  }

  const json = await response.json();
  return parseResult(json);
}

/**
 * 把 Azure 原始响应归一化成便于渲染的结构。
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
    // 常见：NoMatch（没识别到语音）、InitialSilenceTimeout 等
    throw new Error(`未能识别到有效语音（${status || '未知状态'}），请靠近麦克风、读完整句后再评分`);
  }

  const best = json.NBest && json.NBest[0];
  if (!best) throw new Error('评估结果为空，请重试');

  // Azure 有两种返回结构：
  //   1. 分数嵌套在 PronunciationAssessment 子对象里（较新的 detailed 格式）
  //   2. 分数直接扁平挂在对象上（conversation 端点常见）
  // 两种都兼容：优先读嵌套字段，缺失时回退到扁平字段。
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
        // 部分语言（如日语）音素名会返回空串，此时不展示音素明细
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

/** 从多个候选中取第一个有效数字（用于兼容嵌套 / 扁平两种字段布局）。 */
function pickScore(...values) {
  for (const v of values) {
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
  }
  return 0;
}
