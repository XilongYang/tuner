// Regression/feature test for: "能不能加入一个刷新页面时不清空当前Session的功能"
// (add a feature so refreshing the page doesn't clear the current session).
//
// Before this feature, app.js's init() always started from `sentences = []`,
// `currentSessionId = null` -- a real F5 always came back to a blank slate
// even though the session itself was already safely written to IndexedDB by
// every edit's persistSession() call; only the "which one was open" bit
// lived in memory and vanished on reload.
//
// config.js's loadLastSessionId()/saveLastSessionId() now back this with
// sessionStorage (deliberately, not localStorage -- see that file's doc
// comment: it's per-tab, so two tabs can each have a different session open
// without one's reload stealing "current" from the other), and
// state.js's setCurrentSessionId() records it on every change. app.js's
// init() reads it back and reopens that session via history-panel's
// openSession() if it's still there.
//
// This test drives the real UI (types text, clicks Split, does an actual
// page.reload()) rather than importing modules directly, so it exercises
// app.js's actual init() path end to end -- exactly what a real F5 does.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');
await page.waitForLoadState('networkidle');

const sampleText = 'Alpha beta. Gamma delta.';
await page.fill('#input-text', sampleText);
await page.click('#split-btn');
// Split creates the IndexedDB session asynchronously (store.createSession()
// inside handleSplit()); wait for it to land rather than racing the reload
// against it.
await page.waitForFunction(() => sessionStorage.getItem('speak.lastSessionId'));

const beforeReload = await page.evaluate(async () => {
  const stateMod = await import('/js/state.js');
  return {
    lastSessionId: sessionStorage.getItem('speak.lastSessionId'),
    currentSessionId: stateMod.currentSessionId,
    sentenceCount: stateMod.sentences.length,
    rowCount: document.querySelectorAll('.sentence-row').length,
  };
});

await page.reload();
await page.waitForLoadState('networkidle');

const afterReload = await page.evaluate(async () => {
  const stateMod = await import('/js/state.js');
  return {
    lastSessionId: sessionStorage.getItem('speak.lastSessionId'),
    currentSessionId: stateMod.currentSessionId,
    sentenceCount: stateMod.sentences.length,
    rowCount: document.querySelectorAll('.sentence-row').length,
    sentenceTexts: stateMod.sentences.map((s) => s.text),
    inputValue: document.querySelector('#input-text').value,
  };
});

// Now the negative case: a session id left over in sessionStorage that no
// longer exists locally (deleted here, or on another device before this one
// ever synced it) must fail closed to a blank slate, not throw or spin --
// and must forget the dead id rather than retrying it forever.
await page.evaluate(async () => {
  const store = await import('/js/store/index.js');
  const stateMod = await import('/js/state.js');
  await store.deleteSession(stateMod.currentSessionId);
});
await page.reload();
await page.waitForLoadState('networkidle');

const afterDeletedSessionReload = await page.evaluate(async () => {
  const stateMod = await import('/js/state.js');
  return {
    lastSessionId: sessionStorage.getItem('speak.lastSessionId'),
    currentSessionId: stateMod.currentSessionId,
    sentenceCount: stateMod.sentences.length,
    rowCount: document.querySelectorAll('.sentence-row').length,
    inputValue: document.querySelector('#input-text').value,
  };
});

console.log(JSON.stringify({
  beforeReload, afterReload, afterDeletedSessionReload,
}, null, 2));
await browser.close();
console.log('LOGS:', logs);
