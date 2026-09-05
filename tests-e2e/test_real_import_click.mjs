import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.stack || err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');
await page.waitForLoadState('networkidle');

const result = await page.evaluate(async () => {
  const config = await import('/js/config.js');
  config.saveCredentials('fake-key', 'japaneast', 'fake-resource');

  // Build a realistic ~4s WAV: two sentences, "Hello there." and "General
  // Kenobi now." each with 2 words, non-overlapping, real gaps between them
  // -- mirroring what buildWordTimeline()/resegmentByPunctuation() actually
  // receive from Azure.
  const sampleRate = 16000;
  const totalMs = 4000;
  const totalSamples = Math.round((totalMs / 1000) * sampleRate);
  const samples = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) samples[i] = 0.4 * Math.sin(i * 0.25);
  const recorderMod = await import('/js/recorder.js');
  const wavBytes = recorderMod.encodeWav(samples, sampleRate);
  const file = new File([wavBytes], 'test.wav', { type: 'audio/wav' });

  const fakeTranscription = {
    durationMilliseconds: totalMs,
    phrases: [
      {
        locale: 'en-US',
        text: 'Hello there.',
        offsetMilliseconds: 100,
        durationMilliseconds: 900,
        words: [
          { text: 'Hello', offsetMilliseconds: 100, durationMilliseconds: 400 },
          { text: 'there.', offsetMilliseconds: 550, durationMilliseconds: 450 },
        ],
      },
      {
        locale: 'en-US',
        text: 'General Kenobi now.',
        offsetMilliseconds: 1800,
        durationMilliseconds: 1500,
        words: [
          { text: 'General', offsetMilliseconds: 1800, durationMilliseconds: 500 },
          { text: 'Kenobi', offsetMilliseconds: 2350, durationMilliseconds: 500 },
          { text: 'now.', offsetMilliseconds: 2900, durationMilliseconds: 400 },
        ],
      },
    ],
  };

  const originalFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (String(url).includes('transcriptions:transcribe')) {
      return new Response(JSON.stringify(fakeTranscription), { status: 200 });
    }
    return originalFetch(url, opts);
  };

  const splitActionsMod = await import('/js/sentence-panel/split-actions.js');
  await splitActionsMod.handleAudioImport(file);

  const stateMod = await import('/js/state.js');
  return {
    count: stateMod.sentences.length,
    sentences: stateMod.sentences.map((s) => ({ text: s.text, words: s.words, sourceOffsetMs: s.sourceOffsetMs, sourceDurationMs: s.sourceDurationMs })),
  };
});
console.log('IMPORT RESULT:', JSON.stringify(result, null, 2));

// Real DOM click on the SECOND sentence's word-boundary triangle (between
// "General" and "Kenobi"), exactly the way the user would.
const secondRowTriangles = page.locator('.sentence-row').nth(1).locator('.split-pointer-word');
const triangleCount = await secondRowTriangles.count();
console.log('triangleCount on row 2:', triangleCount);

await secondRowTriangles.first().click();
await page.waitForTimeout(800); // let any async work (decode/slice/persist) settle

const afterClick = await page.evaluate(async () => {
  const stateMod = await import('/js/state.js');
  return {
    count: stateMod.sentences.length,
    texts: stateMod.sentences.map((s) => s.text),
  };
});
console.log('AFTER CLICK:', JSON.stringify(afterClick, null, 2));

const rowCountInDom = await page.locator('.sentence-row').count();
const triangleCountInDom = await page.locator('.split-pointer').count();
console.log('rowCountInDom:', rowCountInDom, 'triangleCountInDom:', triangleCountInDom);

await browser.close();
console.log('LOGS:', logs);
