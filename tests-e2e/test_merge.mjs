import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('console', (msg) => logs.push(`[console:${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));

await page.goto('http://127.0.0.1:8934/index.html');

// Split some text into 5 sentences.
const text = ['One.', 'Two.', 'Three.', 'Four.', 'Five.'].join(' ');
await page.fill('#input-text', text);
await page.click('#split-btn');
await page.waitForSelector('.sentence-row');

let rowCount = await page.$$eval('.sentence-row', (rows) => rows.length);
console.log('rowCount after split:', rowCount);

// Merge bar should be hidden initially.
console.log('merge-bar hidden initially:', await page.getAttribute('#merge-bar', 'hidden') !== null);

// Select row 2 and row 4 (indices 1 and 3) -- non-adjacent -- expect row4's checkbox disabled after selecting row2.
const checkboxes = await page.$$('.row-select-checkbox');
console.log('checkbox count:', checkboxes.length);

await checkboxes[1].click(); // select row index 1 (2nd sentence)
let state = await page.evaluate(() => {
  const cbs = Array.from(document.querySelectorAll('.row-select-checkbox'));
  return cbs.map((cb) => ({ checked: cb.checked, disabled: cb.disabled }));
});
console.log('after selecting row2:', JSON.stringify(state));

// Try clicking row 4's checkbox (index 3) -- should be disabled, so .click() should be a no-op (or throw). Use force check via evaluate click won't fire due to disabled.
const isRow4Disabled = state[3].disabled;
console.log('row4 disabled (non-adjacent):', isRow4Disabled);

// row0 (adjacent, index0) and row2 (index2, adjacent) should be enabled.
console.log('row1(idx0) disabled:', state[0].disabled, 'row3(idx2) disabled:', state[2].disabled, 'row5(idx4) disabled:', state[4].disabled);

// Extend selection to row3 (index2) -- adjacent to current max(1).
await checkboxes[2].click();
state = await page.evaluate(() => {
  const cbs = Array.from(document.querySelectorAll('.row-select-checkbox'));
  return cbs.map((cb) => ({ checked: cb.checked, disabled: cb.disabled }));
});
console.log('after selecting row3 too:', JSON.stringify(state));

// Now merge bar should show with Merge button visible (count=2).
const mergeBarHidden = await page.getAttribute('#merge-bar', 'hidden');
const mergeBtnHidden = await page.getAttribute('#merge-btn', 'hidden');
const mergeLabel = await page.textContent('#merge-bar-label');
console.log('mergeBarHidden:', mergeBarHidden, 'mergeBtnHidden:', mergeBtnHidden, 'label:', mergeLabel);

// Deselect the middle... actually only 2 selected (idx1,idx2), both are endpoints. Let's select idx0 too to test middle-removal behavior.
await checkboxes[0].click(); // idx0 now adjacent to min(1)? min=1 so idx0===min-1 -> enabled. select it.
state = await page.evaluate(() => {
  const cbs = Array.from(document.querySelectorAll('.row-select-checkbox'));
  return cbs.map((cb) => ({ checked: cb.checked, disabled: cb.disabled }));
});
console.log('after selecting row1 (idx0) too, now 0,1,2 selected:', JSON.stringify(state));

// Now click middle (idx1) to uncheck -- should reset entire selection to empty (per our fallback logic) since idx1 is not an endpoint (min=0,max=2).
await checkboxes[1].click();
state = await page.evaluate(() => {
  const cbs = Array.from(document.querySelectorAll('.row-select-checkbox'));
  return cbs.map((cb) => ({ checked: cb.checked, disabled: cb.disabled }));
});
console.log('after unchecking middle row2 (idx1):', JSON.stringify(state));
const mergeBarHiddenAfterReset = await page.getAttribute('#merge-bar', 'hidden');
console.log('mergeBar hidden after full reset:', mergeBarHiddenAfterReset);

await browser.close();
console.log('LOGS:', logs.slice(0, 20));
