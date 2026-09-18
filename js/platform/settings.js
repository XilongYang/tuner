// Everything kept in this browser rather than in the database: Azure
// credentials, the container SAS URL, voice choices, and small UI preferences.
//
// Storage is injected, defaulting to the real one, for two reasons. Every read
// and write has to tolerate storage being unavailable -- a private window, or a
// browser configured to refuse it, throws on access rather than returning null
// -- and injecting it is what lets those paths be tested rather than assumed.
//
// Nothing here is sent anywhere except to the service the credential belongs
// to, and none of it is ever written into a session record, so an exported
// backup or a synced manifest can never carry a key.

import { LANGS, LOCALES } from '../model/lang.js';

const KEYS = {
  credentials: 'tuner.credentials',
  sasUrl: 'tuner.blobSasUrl',
  voices: 'tuner.voices',
  deviceId: 'tuner.deviceId',
  lastSessionId: 'tuner.lastSessionId',
  historyOpen: 'tuner.historyOpen',
};

export const DEFAULT_VOICES = {
  'ja-JP': 'ja-JP-NanamiNeural',
  'en-US': 'en-US-JennyNeural',
};

const memoryFallback = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
};

/**
 * @param {Storage} [storage] Defaults to localStorage, falling back to an
 *   in-memory store when the browser refuses access. The fallback keeps the app
 *   usable for the session rather than failing at startup; nothing survives a
 *   reload, which is the honest outcome when storage is unavailable.
 */
export function createSettings(storage = defaultStorage()) {
  const read = (key) => {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  };
  const write = (key, value) => {
    try {
      storage.setItem(key, value);
      return true;
    } catch {
      // Quota exhausted, or storage disabled mid-session. Reported rather than
      // thrown: losing a preference must not take down whatever the user was
      // actually doing.
      return false;
    }
  };
  const remove = (key) => {
    try {
      storage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  };

  const readJson = (key) => {
    const raw = read(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      // Corrupt or hand-edited. Treated as absent, since a half-parsed
      // credential would fail later in a much more confusing place.
      return null;
    }
  };

  return {
    /**
     * Azure Speech credentials, or null when they are not set up.
     *
     * Returns null unless both a key and a region are present: a partial
     * credential produces a request that fails with an unhelpful status, and
     * "not configured" is a state the app can explain.
     */
    credentials() {
      const stored = readJson(KEYS.credentials);
      if (!stored?.key || !stored?.region) return null;
      return {
        key: stored.key,
        region: stored.region,
        // Only transcription needs this, so its absence must not make the other
        // two operations look unconfigured.
        resourceName: stored.resourceName || '',
      };
    },

    saveCredentials({ key, region, resourceName = '' }) {
      return write(KEYS.credentials, JSON.stringify({ key, region, resourceName }));
    },

    clearCredentials() {
      return remove(KEYS.credentials);
    },

    hasCredentials() {
      return this.credentials() !== null;
    },

    /** The container SAS URL cloud sync is bound to, or null. */
    sasUrl() {
      return read(KEYS.sasUrl) || null;
    },
    saveSasUrl(url) {
      return url ? write(KEYS.sasUrl, url) : remove(KEYS.sasUrl);
    },

    /** The chosen voice for a locale, falling back to a sensible default. */
    voice(locale) {
      const stored = readJson(KEYS.voices) || {};
      return stored[locale] || DEFAULT_VOICES[locale] || DEFAULT_VOICES[LOCALES[LANGS[0]]];
    },
    saveVoice(locale, voice) {
      const stored = readJson(KEYS.voices) || {};
      return write(KEYS.voices, JSON.stringify({ ...stored, [locale]: voice }));
    },

    /**
     * A stable id for this browser, minted on first use.
     *
     * Sync uses it to say which device holds the lock. It identifies a browser
     * profile and nothing else -- no account, no person.
     */
    deviceId(generate = () => crypto.randomUUID()) {
      const existing = read(KEYS.deviceId);
      if (existing) return existing;
      const fresh = generate();
      write(KEYS.deviceId, fresh);
      return fresh;
    },

    /** The session to reopen on load, so a refresh does not land on a blank page. */
    lastSessionId() {
      return read(KEYS.lastSessionId) || null;
    },
    saveLastSessionId(id) {
      return id ? write(KEYS.lastSessionId, id) : remove(KEYS.lastSessionId);
    },

    historyOpen() {
      return read(KEYS.historyOpen) === 'true';
    },
    saveHistoryOpen(open) {
      return write(KEYS.historyOpen, open ? 'true' : 'false');
    },
  };
}

function defaultStorage() {
  try {
    // Touched immediately: some browsers expose localStorage but throw on use,
    // and finding that out here means one fallback instead of a failure at the
    // first write.
    const probe = '__tuner_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return memoryFallback();
  }
}

export { KEYS as SETTINGS_KEYS };
