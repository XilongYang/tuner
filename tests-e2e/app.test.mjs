// The app in a real browser, driven the way a person drives it.
//
// Every one of these asserts. The previous suite had 26 browser scripts that
// only printed what they observed and exited 0 whatever the answer, so the
// invariants they appeared to cover -- the split and merge audio geometry above
// all -- were in fact unguarded.
//
// Nothing here touches the network: the speech services are stubbed inside the
// page. What is being tested is that the layers are wired together correctly
// and that the app survives a reload, which is exactly what unit tests cannot
// tell us.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer, PORT } from './server.mjs';

const URL = `http://127.0.0.1:${PORT}/index.html`;

let server;
let browser;

before(async () => {
  server = await startServer();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

/** A fresh page with a clean database, and no real network calls. */
async function openApp() {
  const context = await browser.newContext();
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

  await page.goto(URL);
  await page.waitForFunction(() => Boolean(window.tuner));

  return { page, context, errors };
}

test('loads without errors and offers an empty session', async () => {
  const { page, context, errors } = await openApp();

  assert.equal(await page.locator('.practice-input').count(), 1);
  assert.equal(await page.locator('.sentence-row').count(), 0);
  assert.deepEqual(errors, []);

  await context.close();
});

test('splitting typed text produces one row per sentence', async () => {
  const { page, context, errors } = await openApp();

  await page.fill('.practice-input', 'One sentence. Two sentences. Three.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();

  await page.waitForSelector('.sentence-row');
  assert.equal(await page.locator('.sentence-row').count(), 3);
  assert.deepEqual(
    // The cut markers contribute no text of their own, so the row's text is the
    // sentence exactly -- which is the property worth asserting here.
    await page.locator('.sentence-text').allTextContents(),
    ['One sentence.', 'Two sentences.', 'Three.'],
  );
  assert.deepEqual(errors, []);

  await context.close();
});

test('what was split survives a reload', async () => {
  // The whole persistence path -- autosave, hashing, IndexedDB -- exercised the
  // only way that proves it: by closing the page and coming back.
  const { page, context, errors } = await openApp();

  await page.fill('.practice-input', 'Persisted sentence one. And two.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForSelector('.sentence-row');
  // Saving is debounced, so the test waits for it rather than racing it. What
  // is under test is that a saved session comes back, not how soon it is saved.
  await page.evaluate(() => window.tuner.autosave.flush());

  await page.reload();
  await page.waitForFunction(() => Boolean(window.tuner));
  await page.waitForSelector('.sentence-row');

  assert.equal(await page.locator('.sentence-row').count(), 2);
  assert.deepEqual(errors, []);

  await context.close();
});

test('splitting a sentence at a marker replaces it with two, and keeps the text exactly', async () => {
  const { page, context, errors } = await openApp();

  await page.fill('.practice-input', 'Alpha beta gamma.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForSelector('.sentence-row');

  const before = await page.locator('.sentence-text').first().textContent();
  // The marker before "beta": text-derived positions sit between every pair of
  // characters, so the sixth is the space after "Alpha".
  await page.locator('.split-marker').nth(5).click();
  await page.waitForFunction(() => document.querySelectorAll('.sentence-row').length === 2);

  const after = (await page.locator('.sentence-text').allTextContents()).join('');
  assert.equal(after, before, 'rejoining the halves gives back the original text');
  assert.deepEqual(errors, []);

  await context.close();
});

test('hiding a sentence masks it and withdraws its cut markers', async () => {
  const { page, context } = await openApp();

  await page.fill('.practice-input', 'Maskable sentence.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForSelector('.sentence-row');
  assert.ok(await page.locator('.split-marker').count() > 0);

  await page.getByRole('button', { name: 'Hide text' }).click();

  assert.equal(await page.locator('.split-marker').count(), 0);
  assert.equal(await page.locator('.sentence-mask').count(), 1);
  await page.getByRole('button', { name: 'Show text' }).click();
  assert.ok(await page.locator('.split-marker').count() > 0);

  await context.close();
});

test('the library lists a saved session and opens it', async () => {
  const { page, context, errors } = await openApp();

  await page.fill('.practice-input', 'Session to find later.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForSelector('.sentence-row');
  await page.evaluate(() => window.tuner.autosave.flush());

  await page.getByRole('button', { name: 'Library' }).click();
  await page.waitForSelector('.library-row');
  assert.equal(await page.locator('.library-row').count(), 1);

  // The panel stays open across this, so it is not re-toggled: clicking the
  // toggle again would close it.
  await page.getByRole('button', { name: 'New session' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sentence-row').length === 0);

  await page.locator('.library-open').click();
  await page.waitForSelector('.sentence-row');
  assert.equal(await page.locator('#library').isVisible(), false, 'opening a session closes the library');

  assert.equal(await page.locator('.sentence-row').count(), 1);
  assert.deepEqual(errors, []);

  await context.close();
});

test('deleting a session asks first, and removes it', async () => {
  const { page, context } = await openApp();

  await page.fill('.practice-input', 'Doomed session.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForSelector('.sentence-row');
  await page.evaluate(() => window.tuner.autosave.flush());

  await page.getByRole('button', { name: 'Library' }).click();
  await page.waitForSelector('.library-row');
  await page.locator('.library-row').getByRole('button', { name: 'Delete' }).click();

  await page.waitForSelector('.modal-card');
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();

  await page.waitForFunction(() => document.querySelectorAll('.library-row').length === 0);
  assert.equal(await page.evaluate(() => window.tuner.db.listAll('sessions').then((s) => s.length)), 0);

  await context.close();
});

test('Escape closes an open sidebar', async () => {
  const { page, context } = await openApp();

  await page.getByRole('button', { name: 'Settings' }).click();
  assert.equal(await page.locator('#settings').isVisible(), true);

  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#settings').isVisible(), false);

  await context.close();
});

test('settings report what is missing, and remember what is entered', async () => {
  const { page, context } = await openApp();

  await page.getByRole('button', { name: 'Settings' }).click();
  assert.match(await page.locator('.settings-state').first().textContent(), /Not configured/);

  await page.fill('[aria-label="Azure subscription key"]', 'test-key');
  await page.fill('[aria-label="Azure region"]', 'japaneast');
  await page.locator('.settings-section').first().getByRole('button', { name: 'Save' }).click();

  assert.match(await page.locator('.settings-state').first().textContent(), /Configured for japaneast/);
  assert.equal(await page.inputValue('[aria-label="Azure subscription key"]'), '', 'the key is not echoed back');

  await page.reload();
  await page.waitForFunction(() => Boolean(window.tuner));
  await page.getByRole('button', { name: 'Settings' }).click();
  assert.match(await page.locator('.settings-state').first().textContent(), /Configured for japaneast/);

  await context.close();
});

test('speaking a sentence asks the speech service and keeps the clip', async () => {
  const { page, context, errors } = await openApp();

  // Stubbed in the page: what is under test is the wiring, not Azure.
  await page.evaluate(() => {
    window.tuner.settings.saveCredentials({ key: 'k', region: 'japaneast' });
    const realFetch = window.fetch;
    window.__synthesized = [];
    window.fetch = async (url, options) => {
      if (String(url).includes('tts.speech')) {
        window.__synthesized.push(String(options.body));
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
      }
      return realFetch(url, options);
    };
  });

  await page.fill('.practice-input', 'Speak this line.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForSelector('.sentence-row');
  await page.getByRole('button', { name: 'Speak' }).click();

  await page.waitForFunction(() => window.__synthesized.length === 1);
  assert.match(await page.evaluate(() => window.__synthesized[0]), /Speak this line\./);

  await page.waitForFunction(() => Boolean(window.tuner.store.get().sentences[0].reference));
  assert.deepEqual(errors.filter((e) => !e.includes('play')), []);

  await context.close();
});

test('a failed service call is reported on the sentence, not swallowed', async () => {
  const { page, context } = await openApp();

  await page.evaluate(() => {
    window.tuner.settings.saveCredentials({ key: 'k', region: 'japaneast' });
    const realFetch = window.fetch;
    window.fetch = async (url, options) => (String(url).includes('tts.speech')
      ? new Response('quota exhausted', { status: 429 })
      : realFetch(url, options));
  });

  await page.fill('.practice-input', 'This will fail.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForSelector('.sentence-row');
  await page.getByRole('button', { name: 'Speak' }).click();

  await page.waitForSelector('.sentence-status:not([hidden])');
  assert.match(await page.locator('.sentence-status').textContent(), /quota/i);
  assert.equal(await page.getByRole('button', { name: 'Speak' }).isDisabled(), false, 'and the control works again');

  await context.close();
});

test('without credentials, speaking says what to do rather than failing obscurely', async () => {
  const { page, context } = await openApp();

  await page.fill('.practice-input', 'No credentials here.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForSelector('.sentence-row');
  await page.getByRole('button', { name: 'Speak' }).click();

  await page.waitForSelector('.sentence-status:not([hidden])');
  assert.match(await page.locator('.sentence-status').textContent(), /Azure key and region/);

  await context.close();
});
