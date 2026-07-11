// Azure Speech 凭据管理。
// 关键原则：Key 只保存在浏览器 localStorage，绝不上传到任何服务器。
// 本工具没有后端，所有请求都从浏览器直接发往 Azure。

const STORAGE_KEY = 'speak.azure.credentials';

// 每种语言使用的默认 Neural 语音，可在未来做成可配置。
export const DEFAULT_VOICES = {
  'ja-JP': 'ja-JP-NanamiNeural',
  'en-US': 'en-US-JennyNeural',
};

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
