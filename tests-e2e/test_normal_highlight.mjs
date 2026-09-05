import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');
await page.waitForLoadState('networkidle');

await page.evaluate(async () => {
  const stateMod = await import('/js/state.js');
  const splitMod = await import('/js/sentence-panel/split-render.js');
  const recorderMod = await import('/js/recorder.js');
  const { Recorder, encodeWav } = recorderMod;
  const { setSentences } = stateMod;
  const { render } = splitMod;

  const sampleRate = 16000;
  const totalMs = 1600;
  const samples = new Float32Array(Math.round((totalMs / 1000) * sampleRate));
  for (let i = 0; i < samples.length; i++) samples[i] = 0.4 * Math.sin(i * 0.3);
  const blob = new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' });

  const sentence = {
    id: crypto.randomUUID(), text: 'Alpha beta', lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: blob, referenceUrl: URL.createObjectURL(blob), referenceHash: null, referenceSource: 'import',
    sourceOffsetMs: 0, sourceDurationMs: totalMs,
    words: [
      { offsetMilliseconds: 0, durationMilliseconds: 700, charStart: 0, charEnd: 5 },
      { offsetMilliseconds: 900, durationMilliseconds: 700, charStart: 6, charEnd: 10 },
    ],
    manualPoints: null,
  };
  setSentences([sentence]);
  render();
});

const playBtn = page.locator('.sentence-row').first().locator('button', { hasText: 'Speak' });
await playBtn.click();
await page.waitForTimeout(300);

const result = await page.evaluate(() => {
  const speaking = document.querySelectorAll('.row-char.is-speaking');
  const el = speaking[0];
  const color = el ? getComputedStyle(el).color : null;
  return { speakingCount: speaking.length, color, textOfFirst: el ? el.textContent : null };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
console.log('LOGS:', logs);
