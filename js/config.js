// Azure Speech credential management.
// Core principle: the key is stored only in the browser's localStorage and is
// never uploaded to any server. This tool has no backend — every request goes
// straight from the browser to Azure.

const STORAGE_KEY = 'speak.azure.credentials';

// Default Neural voice per language.
export const DEFAULT_VOICES = {
  'ja-JP': 'ja-JP-NaokiNeural',
  'en-US': 'en-GB-OllieMultilingualNeural',
};

// Selectable Azure Neural voices, grouped by language. `id` is the Azure short
// name; `label` is shown in the UI.
export const VOICE_OPTIONS = {
  'ja-JP': [
    { id: 'ja-JP-NaokiNeural', label: 'Naoki · male' },
    { id: 'ja-JP-NanamiNeural', label: 'Nanami · female' },
    { id: 'ja-JP-KeitaNeural', label: 'Keita · male' },
    { id: 'ja-JP-AoiNeural', label: 'Aoi · female' },
    { id: 'ja-JP-DaichiNeural', label: 'Daichi · male' },
    { id: 'ja-JP-MayuNeural', label: 'Mayu · female' },
    { id: 'ja-JP-ShioriNeural', label: 'Shiori · female' },
  ],
  'en-US': [
    { id: 'en-GB-OllieMultilingualNeural', label: 'Ollie · en-GB · multilingual' },
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

/** Load saved voice choices ({ 'ja-JP': id, 'en-US': id }); empty object if none. */
export function loadVoices() {
  try {
    const raw = localStorage.getItem(VOICES_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Get the chosen voice for a language; falls back to the default when unset or stale. */
export function getVoice(locale) {
  const chosen = loadVoices()[locale];
  const isValid = (VOICE_OPTIONS[locale] || []).some((o) => o.id === chosen);
  return isValid ? chosen : (DEFAULT_VOICES[locale] || DEFAULT_VOICES['en-US']);
}

/** Save the voice choice for a language. */
export function saveVoice(locale, voiceId) {
  const voices = loadVoices();
  voices[locale] = voiceId;
  localStorage.setItem(VOICES_KEY, JSON.stringify(voices));
}

/**
 * Load saved credentials.
 * @returns {{ key: string, region: string, resourceName?: string } | null}
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
 * Save credentials to localStorage.
 * @param {string} key
 * @param {string} region
 * @param {string} [resourceName] Custom subdomain (e.g. "myservice" for
 *   https://myservice.cognitiveservices.azure.com/) -- only needed for the Fast
 *   Transcription audio-import feature, not for the existing recognition/TTS
 *   endpoints, which key off region alone.
 */
export function saveCredentials(key, region, resourceName = '') {
  const value = { key: key.trim(), region: region.trim(), resourceName: resourceName.trim() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  return value;
}

/** Clear the locally saved credentials. */
export function clearCredentials() {
  localStorage.removeItem(STORAGE_KEY);
}

/** Whether credentials are configured. */
export function hasCredentials() {
  return loadCredentials() !== null;
}

// ---- Global "hide text" switch (default value for each per-sentence toggle) ----

const HIDE_TEXT_KEY = 'speak.hideText';

/** Read the global "hide text" switch; off by default. */
export function loadHideText() {
  return localStorage.getItem(HIDE_TEXT_KEY) === '1';
}

/** Save the global "hide text" switch. */
export function saveHideText(on) {
  localStorage.setItem(HIDE_TEXT_KEY, on ? '1' : '0');
}

// ---- History sidebar open/closed state (so it stays as you left it) ----

const HISTORY_OPEN_KEY = 'speak.historyOpen';

/** Read whether the History sidebar was left open; closed by default. */
export function loadHistoryOpen() {
  return localStorage.getItem(HISTORY_OPEN_KEY) === '1';
}

/** Save the History sidebar's open/closed state. */
export function saveHistoryOpen(on) {
  localStorage.setItem(HISTORY_OPEN_KEY, on ? '1' : '0');
}

// ---- Azure Blob Storage backup (container SAS URL) ----

const BLOB_SAS_KEY = 'speak.azureBlob.sasUrl';

/** Load the saved container SAS URL; '' if none is set. */
export function loadBlobSasUrl() {
  try {
    return localStorage.getItem(BLOB_SAS_KEY) || '';
  } catch {
    return '';
  }
}

/** Save the container SAS URL used for cloud backup/restore. */
export function saveBlobSasUrl(url) {
  localStorage.setItem(BLOB_SAS_KEY, url.trim());
}

/** Clear the saved SAS URL. */
export function clearBlobSasUrl() {
  localStorage.removeItem(BLOB_SAS_KEY);
}

/** Whether a SAS URL is configured. */
export function hasBlobSasUrl() {
  return !!loadBlobSasUrl();
}
