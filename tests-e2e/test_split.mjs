// Click-to-split for a plain text sentence. Rewritten against the current UI:
// there is no longer a "click to place a marker, then click a per-row Split
// button to confirm" two-step flow -- every splittable position already has
// its own clickable `.split-pointer` triangle (see split-render.js's
// buildTextEl()), and clicking one splits immediately (row.js's body click
// handler -> split-actions.js's splitAtPointer(), no preview/confirm step;
// see its doc comment). This replaces the old marker-based version of this
// script, which tested a UI that no longer exists.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');

await page.fill('#input-text', 'Hello world.');
await page.click('#split-btn');
await page.waitForSelector('.sentence-row');

const rowCountBefore = await page.$$eval('.sentence-row', (rows) => rows.length);
console.log('row count before split:', rowCountBefore);

// "Hello world." has no Azure word data, so getSplitPointers() falls back to
// textSplitPoints(): for English, one triangle per word gap -- exactly one
// here, between "Hello " and "world.".
const pointerCount = await page.$$eval('.split-pointer', (els) => els.length);
console.log('split-pointer triangle count:', pointerCount);

await page.click('.split-pointer');
await page.waitForTimeout(200);

const rowTexts = await page.$$eval('.row-text', (els) => els.map((el) => el.textContent.trim()));
console.log('rows after split:', JSON.stringify(rowTexts));
const rowCountAfter = await page.$$eval('.sentence-row', (rows) => rows.length);
console.log('row count after split:', rowCountAfter);

// Each new half is itself immediately splittable again if it has more than
// one word/character -- confirms the split didn't leave either half in some
// stuck, pointer-less state.
const pointerCountAfter = await page.$$eval('.split-pointer', (els) => els.length);
console.log('split-pointer triangle count after split:', pointerCountAfter);

await browser.close();
console.log('LOGS:', logs);
