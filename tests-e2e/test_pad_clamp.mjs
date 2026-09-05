import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');

const result = await page.evaluate(async () => {
  const { resegmentByPunctuation } = await import('/js/sentence-panel/audio-decode.js');

  // Two sentences spoken close together: "One." ends at 1000ms, "Two." starts
  // at 1080ms -- only an 80ms gap, less than 2*SLICE_PAD_MS(120)=240ms, so
  // unclamped padding would have each sentence reach 120ms into the other's
  // words. With clamping, each side should only take half the 80ms gap (40ms).
  const phrases = [{
    locale: 'en-US',
    words: [
      { text: 'One.', offsetMilliseconds: 800, durationMilliseconds: 200 }, // ends 1000
      { text: 'Two.', offsetMilliseconds: 1080, durationMilliseconds: 200 }, // starts 1080, ends 1280
      { text: 'Three.', offsetMilliseconds: 3000, durationMilliseconds: 200 }, // isolated -- far gap both sides
    ],
  }];

  const parts = resegmentByPunctuation(phrases, 5000);

  return {
    count: parts.length,
    parts: parts.map((p) => ({ text: p.text, offsetMilliseconds: p.offsetMilliseconds, endMs: p.offsetMilliseconds + p.durationMilliseconds })),
  };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
console.log('LOGS:', logs);
