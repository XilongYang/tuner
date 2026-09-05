// Regression test for: "在初次打开单词详细评分时就显示回放按钮，并且播放我读的
// 这个词" -- opening a word's score popover for the first time (before any
// Retest) should already show the "▶" button, pre-loaded with the exact span
// of the ORIGINAL recording (sentence.recordingBlob) Azure recognized as that
// word (via pron.js's new offsetMs/durationMs), not just after a Retest.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');
await page.waitForLoadState('networkidle');

const setup = await page.evaluate(async () => {
  const recorderMod = await import('/js/recorder.js');
  const assessmentMod = await import('/js/sentence-panel/assessment.js');
  const { Recorder, encodeWav } = recorderMod;
  const { renderAssessment } = assessmentMod;

  // 2s/16kHz recording: "hello" [500,950)ms, "world" [1200,1800)ms -- same
  // shape as a real recordingBlob (encodeWav() output), so decodeWavPcm16()
  // in assessment.js's sliceWordFromRecording() can read it back.
  const sampleRate = 16000;
  const totalMs = 2000;
  const samples = new Float32Array(Math.round((totalMs / 1000) * sampleRate));
  for (let i = 0; i < samples.length; i++) samples[i] = 0.5 * Math.sin(i * 0.3);
  const recordingBlob = new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' });

  const sentence = {
    id: crypto.randomUUID(), text: 'hello world', lang: 'en',
    recorder: new Recorder(), recordingBlob, recordingUrl: URL.createObjectURL(recordingBlob), recordingHash: null,
    assessment: null, referenceBlob: null, referenceUrl: null, referenceSource: null,
  };
  const assessment = {
    overall: { accuracy: 90, fluency: 95, completeness: 100, pron: 91 },
    words: [
      { word: 'hello', accuracy: 88, errorType: 'None', offsetMs: 500, durationMs: 450, phonemes: [] },
      { word: 'world', accuracy: 92, errorType: 'None', offsetMs: 1200, durationMs: 600, phonemes: [] },
      // No timing data (as a stale pre-upgrade assessment would have, or an
      // Omission) -- the playback button must stay hidden for this one.
      { word: 'untimed', accuracy: 70, errorType: 'None', phonemes: [] },
    ],
  };
  sentence.assessment = assessment;

  const container = document.createElement('div');
  container.id = 'test-result';
  document.body.appendChild(container);
  renderAssessment(container, assessment, sentence);

  return { id: sentence.id };
});

// --- 1. Open "hello" (first word): playBtn should be visible immediately,
// with the "from your recording" title, no Retest needed. ---
const words = page.locator('#test-result .word');
await words.nth(0).click();
await page.waitForTimeout(200); // let the async slice (decode+encode) resolve
const helloState = await page.evaluate(() => {
  const openWord = document.querySelector('#test-result .word.is-open');
  const playBtn = openWord.querySelector('.tip-retest-play-btn');
  return { hidden: playBtn.hidden, title: playBtn.title };
});

// --- 2. Click it: should actually play (player marks it active), and it
// should be a DIFFERENT clip than the full recordingUrl (a real slice, not
// just the whole take). ---
await page.locator('#test-result .word.is-open .tip-retest-play-btn').click();
await page.waitForTimeout(100);
const playingState = await page.evaluate(() => {
  const playBtn = document.querySelector('#test-result .word.is-open .tip-retest-play-btn');
  return { isPlaying: playBtn.classList.contains('is-playing') };
});
// Let the short slice (~450ms) finish and the player auto-stop.
await page.waitForTimeout(700);
const afterPlaybackState = await page.evaluate(() => {
  const playBtn = document.querySelector('#test-result .word.is-open .tip-retest-play-btn');
  return { isPlaying: playBtn.classList.contains('is-playing') };
});

// --- 3. Close and reopen the SAME word: still shows the playback button
// (cached slice, no re-decode needed, no error) -- idempotent. ---
await words.nth(0).click(); // close
await page.waitForTimeout(50);
await words.nth(0).click(); // reopen
await page.waitForTimeout(150);
const reopenState = await page.evaluate(() => {
  const openWord = document.querySelector('#test-result .word.is-open');
  const playBtn = openWord.querySelector('.tip-retest-play-btn');
  return { hidden: playBtn.hidden };
});

// --- 4. Open "untimed" (no offsetMs/durationMs at all): playback button
// must stay hidden -- nothing to slice, and no error should be thrown. ---
await words.nth(2).click();
await page.waitForTimeout(200);
const untimedState = await page.evaluate(() => {
  const openWord = document.querySelector('#test-result .word.is-open');
  const playBtn = openWord.querySelector('.tip-retest-play-btn');
  return { hidden: playBtn.hidden };
});

console.log(JSON.stringify({ helloState, playingState, afterPlaybackState, reopenState, untimedState }, null, 2));
await browser.close();
console.log('LOGS:', logs);
