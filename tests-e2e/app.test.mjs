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
  browser = await chromium.launch({
    // Playback has to actually run for the reading to be followed along the
    // text, and nothing here is a user gesture as far as the browser is
    // concerned.
    args: ['--autoplay-policy=no-user-gesture-required'],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
});

/** A WAV tone, so a stubbed speech service can answer with real audio. */
function toneWav(ms, rate = 24000) {
  const samples = Math.floor(rate * ms / 1000);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples * 2, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(samples * 2, 40);
  const body = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) body.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * (i / rate)) * 9000), i * 2);
  return Buffer.concat([header, body]);
}

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

test('splitting puts the text box away, and New session brings it back', async () => {
  const { page, context } = await openApp();

  await page.fill('.practice-input', 'One. Two.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForSelector('.sentence-row');

  assert.equal(await page.locator('.practice-input').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'Import audio' }).isVisible(), false);

  await page.getByRole('button', { name: 'New session' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sentence-row').length === 0);
  assert.equal(await page.locator('.practice-input').isVisible(), true);

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
  // English offers one position per word start, so this sentence has exactly
  // two: before "beta" and before "gamma".
  assert.equal(await page.locator('.split-marker').count(), 2);
  await page.locator('.split-marker').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.sentence-row').length === 2);

  const after = (await page.locator('.sentence-text').allTextContents()).join('');
  assert.equal(after, before, 'rejoining the halves gives back the original text');
  assert.deepEqual(errors, []);

  await context.close();
});

test('ticking two sentences and merging joins them back into one', async () => {
  const { page, context, errors } = await openApp();

  await page.fill('.practice-input', 'Alpha one. Beta two. Gamma three.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForSelector('.sentence-row');
  const before = (await page.locator('.sentence-text').allTextContents()).join(' ');

  await page.locator('.row-select').nth(0).check();
  assert.equal(await page.locator('.merge-bar').isVisible(), true);
  await page.locator('.row-select').nth(1).check();
  await page.getByRole('button', { name: 'Merge', exact: true }).click();

  await page.waitForFunction(() => document.querySelectorAll('.sentence-row').length === 2);
  assert.equal((await page.locator('.sentence-text').allTextContents()).join(' '), before,
    'the text reads the same, in one fewer sentence -- the merged seam gets back its space');
  assert.equal(await page.locator('.merge-bar').isVisible(), false, 'and the selection is spent');
  assert.deepEqual(errors, []);

  await context.close();
});

test('sentences that would break the run cannot be selected at all', async () => {
  const { page, context } = await openApp();

  await page.fill('.practice-input', 'Alpha one. Beta two. Gamma three.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForSelector('.sentence-row');

  await page.locator('.row-select').nth(0).check();

  assert.equal(await page.locator('.row-select').nth(1).isEnabled(), true, 'the neighbour extends the run');
  assert.equal(await page.locator('.row-select').nth(2).isEnabled(), false, 'the one beyond it does not');

  await context.close();
});

test('hiding a sentence masks it and withdraws its cut markers', async () => {
  const { page, context } = await openApp();

  await page.fill('.practice-input', 'Maskable sentence.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForSelector('.sentence-row');
  assert.ok(await page.locator('.split-marker').count() > 0);

  const markers = await page.locator('.split-marker').count();
  await page.getByRole('button', { name: 'Hide', exact: true }).click();

  assert.equal(await page.locator('.sentence-text.is-hidden-text').count(), 1);
  assert.equal(await page.locator('.split-marker').count(), markers, 'still splittable while practising from memory');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  assert.equal(await page.locator('.sentence-text.is-hidden-text').count(), 0);

  await context.close();
});

test('the header switch hides every sentence, and holds across a reload and a new split', async () => {
  const { page, context } = await openApp();

  await page.fill('.practice-input', 'One. Two.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForSelector('.sentence-row');

  await page.locator('#hide-all').check();
  await page.waitForFunction(() => document.querySelectorAll('.sentence-text.is-hidden-text').length === 2);

  await page.evaluate(() => window.tuner.autosave.flush());
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.sentence-row').length === 2);
  assert.equal(await page.locator('#hide-all').isChecked(), true, 'the switch reads the session it came back to');
  assert.equal(await page.locator('.sentence-text.is-hidden-text').count(), 2);

  // Splitting more text while practising from memory must not put it back.
  await page.getByRole('button', { name: 'New session' }).click();
  await page.fill('.practice-input', 'Three. Four.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sentence-row').length === 2);
  assert.equal(await page.locator('.sentence-text.is-hidden-text').count(), 2);

  await context.close();
});

test('a session nothing has been split into is not put in the library', async () => {
  const { page, context } = await openApp();

  // The app opens with a blank session on screen; typing alone does not make
  // it one worth keeping.
  await page.fill('.practice-input', 'Typed, but not split yet.');
  await page.evaluate(() => window.tuner.autosave.flush());

  await page.getByRole('button', { name: 'Library' }).click();
  await page.waitForSelector('.panel-empty:not([hidden])');
  assert.equal(await page.locator('.library-row').count(), 0);
  assert.equal(await page.evaluate(async () => (await window.tuner.db.listAll('sessions')).length), 0);

  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForSelector('.sentence-row');
  await page.evaluate(() => window.tuner.autosave.flush());

  // Closed and opened again: the library lists what is stored when it opens.
  await page.getByRole('button', { name: 'Library' }).click();
  await page.getByRole('button', { name: 'Library' }).click();
  await page.waitForSelector('.library-row');
  assert.equal(await page.locator('.library-row').count(), 1, 'splitting is what makes it a session');

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

  const marked = () => page.locator('.library-row.is-current').count();
  assert.equal(await marked(), 1, 'the session on screen is the one marked');

  // The panel stays open across this, so it is not re-toggled: clicking the
  // toggle again would close it.
  await page.getByRole('button', { name: 'New session' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sentence-row').length === 0);
  assert.equal(await marked(), 0, 'a blank session is not one of the saved ones');

  await page.locator('.library-open').click();
  await page.waitForSelector('.sentence-row');

  assert.equal(await page.locator('#library').isVisible(), true, 'the library stays open, for picking the next one');
  assert.equal(await marked(), 1, 'and says which one was picked');
  assert.equal(await page.locator('.sentence-row').count(), 1);
  assert.deepEqual(errors, []);

  await context.close();
});

test('reopening the library lists the session once, not once per visit', async () => {
  // The path a user actually took: split, open the library, click the session
  // that is already on screen, open the library again -- and see it twice, with
  // deleting either copy taking both away.
  const { page, context, errors } = await openApp();

  await page.fill('.practice-input', 'One. Two.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForSelector('.sentence-row');
  // Autosave writes on a delay, and the library lists what is stored.
  await page.evaluate(() => window.tuner.autosave.flush());

  for (let visit = 0; visit < 2; visit++) {
    await page.getByRole('button', { name: 'Library' }).click();
    await page.waitForSelector('.library-row');
    await page.locator('.library-open').first().click();
    await page.waitForTimeout(50);
    // The library stays open now, so it is closed here to make the next visit
    // a fresh one -- which is what repaints the list.
    await page.getByRole('button', { name: 'Library' }).click();
  }

  await page.getByRole('button', { name: 'Library' }).click();
  await page.waitForSelector('.library-row');
  assert.equal(await page.locator('.library-row').count(), 1);
  // Whether the list duplicates rows or refuses to repaint at all, this catches
  // it: a repaint that throws lands here as a page error.
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

test('the header controls sit on the column, above the title, and the panel beside it', async () => {
  const { page, context } = await openApp();
  await page.setViewportSize({ width: 1440, height: 800 });

  // Split first: after that the controls row is the first thing in the column,
  // which is what an open panel lines its own first row up with.
  await page.fill('.practice-input', 'Alpha beta.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForSelector('.sentence-row');

  const edges = async (selector) => {
    const box = await page.locator(selector).boundingBox();
    return box && { left: Math.round(box.x), right: Math.round(box.x + box.width) };
  };

  const closed = { toggle: await edges('.global-toggle'), nav: await edges('.app-nav'), main: await edges('.app-main') };
  assert.ok(closed.toggle.left >= closed.main.left && closed.toggle.left < closed.main.left + 40,
    'the switch sits at the column, not at the edge of the screen');
  assert.ok(closed.nav.right <= closed.main.right && closed.nav.right > closed.main.right - 40);

  const bar = await page.locator('.app-bar').boundingBox();
  const title = await page.locator('.app-title').boundingBox();
  assert.ok(bar.y + bar.height <= title.y, 'the controls are a row above the title, not beside it');

  await page.getByRole('button', { name: 'Library' }).click();
  await page.waitForSelector('#library:not([hidden])');

  const open = { toggle: await edges('.global-toggle'), nav: await edges('.app-nav'), main: await edges('.app-main'), panel: await edges('#library') };

  // The panel starts where the column does, so its first row is level with the
  // practice controls beside it.
  const top = async (selector) => Math.round((await page.locator(selector).first().boundingBox()).y);
  assert.equal(await top('.panel-tabs'), await top('.practice-controls'));
  assert.equal(await page.locator('.panel-title').count(), 0, 'and it does not repeat its own name');
  assert.ok(open.panel.left >= open.main.right, 'the panel is beside the column, not on top of it');
  assert.equal(open.main.right - open.main.left, closed.main.right - closed.main.left, 'the column is the same width');
  assert.ok(open.main.left < closed.main.left, 'and the pair re-centres, so it moved left');
  // The masthead is the column's own width and travels with it, whether or not
  // a panel is beside it.
  assert.equal(open.toggle.left - open.main.left, closed.toggle.left - closed.main.left);
  assert.equal(open.nav.right - open.main.right, closed.nav.right - closed.main.right);
  assert.ok(open.nav.right < open.panel.left, 'the panel links stay over the column, not over the panel');

  await context.close();
});

test('the open panel is the one marked open', async () => {
  const { page, context } = await openApp();
  const state = (name) => page.getByRole('button', { name }).getAttribute('aria-expanded');

  assert.deepEqual([await state('Library'), await state('Settings')], ['false', 'false']);

  await page.getByRole('button', { name: 'Library' }).click();
  assert.deepEqual([await state('Library'), await state('Settings')], ['true', 'false']);

  await page.getByRole('button', { name: 'Settings' }).click();
  assert.deepEqual([await state('Library'), await state('Settings')], ['false', 'true'], 'only one at a time');

  await page.keyboard.press('Escape');
  assert.deepEqual([await state('Library'), await state('Settings')], ['false', 'false']);

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
  assert.equal(await page.locator('.settings-form').isVisible(), false, 'the form gives way to Clear');
  assert.equal(await page.getByRole('button', { name: 'Clear', exact: true }).isVisible(), true);

  await page.reload();
  await page.waitForFunction(() => Boolean(window.tuner));
  await page.getByRole('button', { name: 'Settings' }).click();
  assert.match(await page.locator('.settings-state').first().textContent(), /Configured for japaneast/);
  assert.equal(await page.locator('.settings-form').isVisible(), false);

  await context.close();
});

test('voices are picked from a list, and the choice survives a reload', async () => {
  const { page, context } = await openApp();

  await page.getByRole('button', { name: 'Settings' }).click();
  const japanese = page.locator('[aria-label="Japanese voice"]');
  const english = page.locator('[aria-label="English voice"]');

  assert.equal(await japanese.inputValue(), 'ja-JP-NaokiNeural', 'opens on the voice in use');
  assert.equal(await english.inputValue(), 'en-GB-OllieMultilingualNeural');
  assert.ok((await japanese.locator('option').count()) > 1, 'and offers the others');

  await japanese.selectOption('ja-JP-ShioriNeural');

  await page.reload();
  await page.waitForFunction(() => Boolean(window.tuner));
  await page.getByRole('button', { name: 'Settings' }).click();
  assert.equal(await page.locator('[aria-label="Japanese voice"]').inputValue(), 'ja-JP-ShioriNeural');

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

test('a reading is followed along the text, a word at a time', async () => {
  const { page, context, errors } = await openApp();

  // The service reads the sentence, and -- asked afterwards -- says where each
  // word fell in what it read. Synthesis alone reports no timings at all, so
  // this second round trip is the only source of them for a typed session.
  await context.route('**/cognitiveservices/v1', (route) => route.fulfill({
    status: 200, headers: { 'Content-Type': 'audio/wav' }, body: toneWav(2000),
  }));
  await context.route('**/speechtotext/transcriptions:transcribe**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      durationMilliseconds: 2000,
      phrases: [{
        locale: 'en-US',
        words: [
          { text: 'Alpha', offsetMilliseconds: 0, durationMilliseconds: 600 },
          { text: 'beta', offsetMilliseconds: 700, durationMilliseconds: 500 },
          { text: 'gamma.', offsetMilliseconds: 1300, durationMilliseconds: 600 },
        ],
      }],
    }),
  }));

  await page.evaluate(() => window.tuner.settings.saveCredentials({ key: 'k', region: 'r', resourceName: 'res' }));
  await page.reload();
  await page.waitForFunction(() => Boolean(window.tuner));

  await page.fill('.practice-input', 'Alpha beta gamma.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForSelector('.sentence-row');
  await page.getByRole('button', { name: 'Speak' }).click();

  await page.waitForFunction(() => (window.tuner.store.get().sentences[0].words || []).length === 3);

  const lit = () => page.evaluate(() => [...document.querySelectorAll('.sentence-char.is-speaking')].map((c) => c.textContent).join(''));
  await page.waitForFunction(() => document.querySelector('.sentence-char.is-speaking')?.textContent === 'A');
  assert.equal(await lit(), 'Alpha', 'the first word is lit while it is being read');

  await page.waitForFunction(() => [...document.querySelectorAll('.sentence-char.is-speaking')].map((c) => c.textContent).join('') === 'beta');
  assert.equal(await lit(), 'beta', 'and the highlight moves on with the reading');

  assert.deepEqual(errors, []);
  await context.close();
});

test('a reading with no word timings leaves the text alone rather than guessing', async () => {
  const { page, context } = await openApp();

  await context.route('**/cognitiveservices/v1', (route) => route.fulfill({
    status: 200, headers: { 'Content-Type': 'audio/wav' }, body: toneWav(600),
  }));
  // No resource name, so there is nothing to ask for timings with.
  await page.evaluate(() => window.tuner.settings.saveCredentials({ key: 'k', region: 'r' }));
  await page.reload();
  await page.waitForFunction(() => Boolean(window.tuner));

  await page.fill('.practice-input', 'Alpha beta gamma.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForSelector('.sentence-row');
  await page.getByRole('button', { name: 'Speak' }).click();
  await page.waitForTimeout(500);

  assert.equal(await page.locator('.sentence-char.is-speaking').count(), 0);
  assert.equal(await page.evaluate(() => window.tuner.store.get().sentences[0].words), null);

  await context.close();
});
