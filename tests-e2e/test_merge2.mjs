import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));

await page.goto('http://127.0.0.1:8934/index.html');

const text = ['One.', 'Two.', 'Three.'].join(' ');
await page.fill('#input-text', text);
await page.click('#split-btn');
await page.waitForSelector('.sentence-row');

// Select rows 1 and 2 (idx0, idx1) and click Merge.
const checkboxes = await page.$$('.row-select-checkbox');
await checkboxes[0].click();
await checkboxes[1].click();

const mergeBtnVisible = await page.isVisible('#merge-btn');
console.log('merge btn visible before click:', mergeBtnVisible);

await page.click('#merge-btn');
await page.waitForTimeout(200);

const rowTexts = await page.$$eval('.row-text', (els) => els.map((el) => el.textContent));
console.log('rows after merge:', JSON.stringify(rowTexts));

const rowCount = await page.$$eval('.sentence-row', (rows) => rows.length);
console.log('rowCount after merge:', rowCount);

// Merge bar should be hidden again (selection cleared).
console.log('merge-bar hidden after merge:', await page.getAttribute('#merge-bar', 'hidden') !== null);

// Verify merged row's buttons: Playback/Score/Export should be hidden (fresh sentence, no recording).
const btnState = await page.$$eval('.sentence-row', (rows) => rows.map((row) => {
  const btns = Array.from(row.querySelectorAll('.row-actions .btn'));
  const byText = {};
  for (const b of btns) byText[b.textContent] = b.hidden;
  return byText;
}));
console.log('button hidden state per row:', JSON.stringify(btnState));

// Test Cancel button: select one row, click Cancel, ensure selection clears.
await checkboxes.length; // stale refs after re-render; re-query
const cbs2 = await page.$$('.row-select-checkbox');
await cbs2[0].click();
console.log('merge-bar hidden after selecting 1:', await page.getAttribute('#merge-bar', 'hidden') !== null);
await page.click('#merge-cancel-btn');
const cbState = await page.evaluate(() => Array.from(document.querySelectorAll('.row-select-checkbox')).map((cb) => cb.checked));
console.log('checkbox states after cancel:', JSON.stringify(cbState));
console.log('merge-bar hidden after cancel:', await page.getAttribute('#merge-bar', 'hidden') !== null);

await browser.close();
console.log('LOGS:', logs);
