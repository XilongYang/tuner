// Installs a real DOM (via jsdom, loading the actual index.html so every id
// state.js's `els` cache looks up at import time actually resolves) as the
// global `document`/`window`/`localStorage`, so js/state.js -- and anything
// that transitively imports it (js/sync/azure-sync.js, js/sync/restore.js,
// js/config.js) -- can be exercised in plain Node instead of only ever being
// covered by the Playwright e2e suite. Import this FIRST, before
// './setup-indexeddb.mjs' and before importing any DOM-touching module, in
// any test file that needs one.
//
// Deliberately real jsdom, not a hand-rolled stub object: state.js's `els`
// does ~50 `document.querySelector('#some-id')` calls at module-evaluation
// time, so a stub would need to know every one of those ids by hand and
// silently drift from index.html the moment either side changed. Loading the
// real file means these tests break loudly (a missing/renamed id throws
// immediately on import) instead of quietly testing against a fake DOM
// shape that no longer matches the real page.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/' });

global.window = dom.window;
global.document = dom.window.document;
// Node itself already defines a global `navigator` (its own built-in, getter-
// only) -- plain assignment throws; redefine the property instead so jsdom's
// version (with a settable `.locks`, stubbed below) wins.
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.localStorage = dom.window.localStorage;
global.HTMLElement = dom.window.HTMLElement;
global.DOMParser = dom.window.DOMParser;

// jsdom implements neither the Web Locks API (scheduler.js's
// navigator.locks.request(), only ever called from an explicit
// scheduleAutoSync()/runAutoSync() call, never at import time) nor
// <audio>/URL.createObjectURL playback (tts-player.js/vocab-panel's
// concern, not the sync-decision logic these tests exercise) -- neither is
// needed for the module-import graph itself, only stubbed here so a test
// that happens to reach one of those call sites gets a clear "not
// implemented in this harness" rather than a jsdom "not implemented" crash
// deep in an unrelated code path.
if (!dom.window.navigator.locks) {
  dom.window.navigator.locks = {
    request: () => { throw new Error('navigator.locks is not available in the test DOM (scheduler.js only -- not used by these tests).'); },
  };
}
global.URL.createObjectURL ??= () => { throw new Error('URL.createObjectURL is not available in the test DOM (audio playback only -- not used by these tests).'); };
