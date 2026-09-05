// Regression test for: parseResult() (pron.js) now also extracts each word's
// Offset/Duration (Azure's 100-nanosecond ticks) into offsetMs/durationMs, so
// assessment.js can slice the exact span of the recording that was scored for
// playback. Omission words (no audio actually spoken) should come back with
// offsetMs/durationMs undefined, not 0 -- "no timing data" must stay distinct
// from "a real zero-length span".
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');
await page.waitForLoadState('networkidle');

const result = await page.evaluate(async () => {
  const { parseResult } = await import('/js/pron.js');

  // Shaped like Azure's actual format=detailed + Pronunciation-Assessment
  // response: NBest[0].Words[] with Offset/Duration in ticks (100ns units) at
  // the top level, and per-word scores nested under PronunciationAssessment.
  const json = {
    RecognitionStatus: 'Success',
    DisplayText: 'Hello world.',
    NBest: [{
      Display: 'Hello world.',
      PronunciationAssessment: { AccuracyScore: 95, FluencyScore: 99, CompletenessScore: 100, PronScore: 96 },
      Words: [
        {
          Word: 'hello', Offset: 5000000, Duration: 4500000, // 500ms .. 950ms
          PronunciationAssessment: { AccuracyScore: 90, ErrorType: 'None' },
          Phonemes: [],
        },
        {
          Word: 'world', Offset: 12000000, Duration: 6000000, // 1200ms .. 1800ms
          PronunciationAssessment: { AccuracyScore: 92, ErrorType: 'None' },
          Phonemes: [],
        },
        {
          // Omission: in the reference but never actually spoken -- Azure
          // gives it no real Offset/Duration.
          Word: 'there',
          PronunciationAssessment: { AccuracyScore: 0, ErrorType: 'Omission' },
          Phonemes: [],
        },
      ],
    }],
  };

  const parsed = parseResult(json);
  return {
    words: parsed.words.map((w) => ({ word: w.word, offsetMs: w.offsetMs, durationMs: w.durationMs, errorType: w.errorType })),
  };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
console.log('LOGS:', logs);
