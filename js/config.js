// Azure Speech 凭据管理。
// 关键原则：Key 只保存在浏览器 localStorage，绝不上传到任何服务器。
// 本工具没有后端，所有请求都从浏览器直接发往 Azure。

const STORAGE_KEY = 'speak.azure.credentials';

// 每种语言使用的默认 Neural 语音。
export const DEFAULT_VOICES = {
  'ja-JP': 'ja-JP-NanamiNeural',
  'en-US': 'en-US-JennyNeural',
};

// 可选的 Azure Neural 音色（按语言分组）。id 为 Azure 短名，label 供界面展示。
export const VOICE_OPTIONS = {
  'ja-JP': [
    { id: 'ja-JP-NanamiNeural', label: 'Nanami · female' },
    { id: 'ja-JP-KeitaNeural', label: 'Keita · male' },
    { id: 'ja-JP-AoiNeural', label: 'Aoi · female' },
    { id: 'ja-JP-DaichiNeural', label: 'Daichi · male' },
    { id: 'ja-JP-MayuNeural', label: 'Mayu · female' },
    { id: 'ja-JP-NaokiNeural', label: 'Naoki · male' },
    { id: 'ja-JP-ShioriNeural', label: 'Shiori · female' },
  ],
  'en-US': [
    { id: 'en-US-JennyNeural', label: 'Jenny · female' },
    { id: 'en-US-AriaNeural', label: 'Aria · female' },
    { id: 'en-US-SaraNeural', label: 'Sara · female' },
    { id: 'en-US-NancyNeural', label: 'Nancy · female' },
    { id: 'en-US-MichelleNeural', label: 'Michelle · female' },
    { id: 'en-US-GuyNeural', label: 'Guy · male' },
    { id: 'en-US-DavisNeural', label: 'Davis · male' },
    { id: 'en-US-JasonNeural', label: 'Jason · male' },
    { id: 'en-US-TonyNeural', label: 'Tony · male' },
    { id: 'en-US-RogerNeural', label: 'Roger · male' },
  ],
};

const VOICES_KEY = 'speak.voices';

/** 读取已保存的音色选择（{ 'ja-JP': id, 'en-US': id }），无则空对象。 */
export function loadVoices() {
  try {
    const raw = localStorage.getItem(VOICES_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 取某语言当前选用的音色，未选择时回退到默认音色。 */
export function getVoice(locale) {
  const chosen = loadVoices()[locale];
  return chosen || DEFAULT_VOICES[locale] || DEFAULT_VOICES['en-US'];
}

/** 保存某语言的音色选择。 */
export function saveVoice(locale, voiceId) {
  const voices = loadVoices();
  voices[locale] = voiceId;
  localStorage.setItem(VOICES_KEY, JSON.stringify(voices));
}

/**
 * 读取已保存的凭据。
 * @returns {{ key: string, region: string } | null}
 */
export function loadCredentials() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.key && parsed.region) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * 保存凭据到 localStorage。
 * @param {string} key
 * @param {string} region
 */
export function saveCredentials(key, region) {
  const value = { key: key.trim(), region: region.trim() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  return value;
}

/** 清除本地保存的凭据。 */
export function clearCredentials() {
  localStorage.removeItem(STORAGE_KEY);
}

/** 是否已配置凭据。 */
export function hasCredentials() {
  return loadCredentials() !== null;
}

// ---- 隐藏正文的全局开关（控制每句独立开关的默认值） ----

const HIDE_TEXT_KEY = 'speak.hideText';

/** 读取全局「隐藏正文」开关，默认关闭。 */
export function loadHideText() {
  return localStorage.getItem(HIDE_TEXT_KEY) === '1';
}

/** 保存全局「隐藏正文」开关。 */
export function saveHideText(on) {
  localStorage.setItem(HIDE_TEXT_KEY, on ? '1' : '0');
}
