// Regression test for: "文本模式现在也在分割完成后隐藏文本框，并且把Split改成New
// Session" -- a plain text (non-audio) session should get the same
// input-box-hidden / "New Session" button treatment as an audio-imported
// session, once it's actually been split (currentSplitMode stays 'auto' for
// text sessions -- split.js's isSessionLocked() now also checks
// sentences.length to tell "already split" apart from the blank slate).
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');
await page.waitForLoadState('networkidle');

// --- 1. Before any Split: box visible, button says "Split". The textarea
// lives inside #input-mask-wrap, which is what applyAudioSessionLock()
// actually hides/shows (not the textarea's own `hidden`). ---
const beforeSplit = await page.evaluate(() => {
  const label = document.querySelector('#input-label');
  const maskWrap = document.querySelector('#input-mask-wrap');
  const btn = document.querySelector('#split-btn');
  const importBtn = document.querySelector('#audio-import-btn');
  return { maskWrapHidden: maskWrap.hidden, labelHidden: label ? label.hidden : null, btnText: btn.textContent, importBtnHidden: importBtn ? importBtn.hidden : null };
});

// --- 2. Fill text and Split: box should now hide, button relabels to "New Session". ---
await page.fill('#input-text', 'Hello world.');
await page.click('#split-btn');
await page.waitForSelector('.sentence-row');
await page.waitForTimeout(150);

const afterSplit = await page.evaluate(() => {
  const input = document.querySelector('#input-text');
  const label = document.querySelector('#input-label');
  const maskWrap = document.querySelector('#input-mask-wrap');
  const btn = document.querySelector('#split-btn');
  const clearBtn = document.querySelector('#clear-input-btn');
  const importBtn = document.querySelector('#audio-import-btn');
  return {
    inputReadOnly: input.readOnly,
    labelHidden: label ? label.hidden : null,
    maskWrapHidden: maskWrap ? maskWrap.hidden : null,
    clearBtnHidden: clearBtn ? clearBtn.hidden : null,
    btnText: btn.textContent,
    importBtnHidden: importBtn ? importBtn.hidden : null,
  };
});

// --- 3. Clicking "New Session" clears back to the blank slate: box visible
// again, button back to "Split". ---
await page.click('#split-btn');
await page.waitForTimeout(150);
const afterNewSession = await page.evaluate(() => {
  const input = document.querySelector('#input-text');
  const label = document.querySelector('#input-label');
  const maskWrap = document.querySelector('#input-mask-wrap');
  const btn = document.querySelector('#split-btn');
  const importBtn = document.querySelector('#audio-import-btn');
  return { maskWrapHidden: maskWrap.hidden, inputValue: input.value, labelHidden: label ? label.hidden : null, btnText: btn.textContent, rowCount: document.querySelectorAll('.sentence-row').length, importBtnHidden: importBtn ? importBtn.hidden : null };
});

console.log(JSON.stringify({ beforeSplit, afterSplit, afterNewSession }, null, 2));
await browser.close();
console.log('LOGS:', logs);
