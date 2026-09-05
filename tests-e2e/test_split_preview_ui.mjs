import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');
await page.waitForLoadState('networkidle');

async function setup() {
  return page.evaluate(async () => {
    const stateMod = await import('/js/state.js');
    const splitMod = await import('/js/sentence-panel/split-render.js');
    const recorderMod = await import('/js/recorder.js');
    const { Recorder, encodeWav } = recorderMod;
    const { setSentences, setSourceAudio, setCurrentSessionId } = stateMod;
    const { render } = splitMod;
    const store = await import('/js/store/index.js');

    const sampleRate = 16000;
    const totalMs = 2000;
    const totalSamples = Math.round((totalMs / 1000) * sampleRate);
    const samples = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) samples[i] = 0.5 * Math.sin(i * 0.3);
    const sourceBlob = new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' });
    setSourceAudio(sourceBlob, 'test-hash');

    const sentenceId = crypto.randomUUID();
    // "One two three" with two real Azure word pointers: "two" at char 4
    // (ms 500) and "three" at char 8 (ms 1300). Splitting at the "three"
    // triangle leaves "One two" behind, which still carries the "two"
    // pointer -- so a further marker placed left of THAT (char 1, inside
    // "O|ne") has no pointer of its own anywhere nearby: nothing to split,
    // just the hint pointing at the remaining triangle.
    const sentence = {
      id: sentenceId, text: 'One two three', lang: 'en', hidden: false, recorder: new Recorder(),
      recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
      referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: 'import',
      sourceOffsetMs: 0, sourceDurationMs: totalMs,
      words: [
        { offsetMilliseconds: 500, durationMilliseconds: 300, charStart: 4, charEnd: 7 },
        { offsetMilliseconds: 1300, durationMilliseconds: 700, charStart: 8, charEnd: 13 },
      ],
      manualPoints: null,
    };
    // A second sentence with no Azure word data at all -- Split should be an
    // instant text-only split once a marker is placed on it, no different
    // from any other actionable marker.
    const plainSentence = {
      id: crypto.randomUUID(), text: 'No word data here', lang: 'en', hidden: false, recorder: new Recorder(),
      recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
      referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: null,
      sourceOffsetMs: null, sourceDurationMs: null, words: null, manualPoints: null,
    };
    setSentences([sentence, plainSentence]);

    const sessionId = await store.createSession({
      inputText: `${sentence.text} ${plainSentence.text}`, splitMode: 'audio',
      sentences: [sentence, plainSentence].map(stateMod.sentenceToRecord),
      sourceAudioBlob: sourceBlob, sourceAudioHash: 'test-hash',
    });
    setCurrentSessionId(sessionId);

    render();
    await new Promise((r) => setTimeout(r, 150)); // let the page fully settle before the first synthetic click
    return { sentenceId, sessionId };
  });
}

await setup();

// --- 1. Clicking the real word-boundary triangle ("three", char 8) splits instantly, no hint/button shown. ---
await page.locator('.split-pointer-word[data-char-index="8"]').click();
await page.waitForFunction(async () => {
  const mod = await import('/js/state.js');
  return mod.sentences.length === 3; // "One two" / "three" / the untouched plain sentence
});
const afterTriangleClick = await page.evaluate(async () => {
  const mod = await import('/js/state.js');
  return { count: mod.sentences.length, texts: mod.sentences.map((s) => s.text) };
});
// The click-anywhere-in-the-text marker/hint UI (and the fine-tune canvas
// before it) is gone entirely -- getSplitPointers() always has a triangle at
// every splittable position now, so there's nothing left for it to do. Both
// classes should be absent from the DOM outright, not just hidden.
const noLeftoverMarkerUi = await page.evaluate(() => ({
  hintCount: document.querySelectorAll('.split-hint').length,
  markerCount: document.querySelectorAll('.split-marker').length,
  fineTuneCanvasCount: document.querySelectorAll('.split-finetune-canvas').length,
}));

// --- 2. A real click landing between two characters that ISN'T on a
// triangle (row.js's body click handler now only reacts to .split-pointer)
// does nothing at all: no marker, no button, no state change. Click right
// between the row's first two characters ("O|ne two"). ---
const oneTwoRow = page.locator('.sentence-row').filter({ hasText: 'One' }).first();
const chars = oneTwoRow.locator('.row-char');
// locator.click({position}) scrolls the element into view first -- unlike
// raw page.mouse.click(x, y), which uses viewport-relative coordinates and
// silently misses a row that's currently scrolled below the fold.
await chars.nth(1).click({ position: { x: 0, y: 2 } });
await new Promise((r) => setTimeout(r, 150));

const midTextClickIsNoop = await page.evaluate(() => {
  const row = Array.from(document.querySelectorAll('.sentence-row'))
    .find((r) => r.querySelector('.row-text').textContent.includes('One'));
  return {
    noMarkerDrawn: row.querySelectorAll('.split-marker').length === 0,
    noHintDrawn: row.querySelectorAll('.split-hint').length === 0,
    fineTuneCanvasExists: !!row.querySelector('.split-finetune-canvas'),
  };
});
const sentenceCountUnchangedByMidTextClick = await page.evaluate(async () => {
  const mod = await import('/js/state.js');
  return mod.sentences.length;
});

// --- 3. A sentence with no Azure word data at all: getSplitPointers()'s
// textSplitPoints() fallback (split.js) now offers a synthetic triangle at
// every word gap here too ("No ▾word ▾data ▾here", string char indices
// 3/8/13) -- clicking one splits it exactly the same way a real word-pointer
// triangle does (step 1), unlike the old dedicated "always actionable, split
// anywhere" text-only marker rule this replaced. Third row by now -- step
// 1's triangle click already turned the first sentence into two rows ("One
// two", "three"), pushing the plain sentence to index 2. Not matched by
// textContent: the inserted triangle glyphs land between words and break a
// plain substring match ("No ▾word ▾data ▾here").
const plainRow = page.locator('.sentence-row').nth(2);
await plainRow.locator('.split-pointer[data-char-index="8"]').click();
await page.waitForFunction(async () => {
  const mod = await import('/js/state.js');
  return mod.sentences.length === 4; // "One two" / "three" / "No word " / "data here"
}, { timeout: 3000 }).catch(() => {});
const finalState = await page.evaluate(async () => {
  const mod = await import('/js/state.js');
  return { count: mod.sentences.length, texts: mod.sentences.map((s) => s.text) };
});
const plainSplitResult = await page.evaluate(async () => {
  const mod = await import('/js/state.js');
  const [, , left, right] = mod.sentences;
  return {
    leftText: left && left.text, rightText: right && right.text,
    // Same audio-clearing behavior as before -- there was never any real
    // audio to slice for this sentence, unified path or not.
    bothAudioCleared: left && left.referenceBlob == null && right && right.referenceBlob == null
      && left.sourceOffsetMs == null && right.sourceOffsetMs == null,
  };
});

console.log(JSON.stringify({
  afterTriangleClick, noLeftoverMarkerUi,
  midTextClickIsNoop, sentenceCountUnchangedByMidTextClick,
  finalState, plainSplitResult,
}, null, 2));

await browser.close();
console.log('LOGS:', logs);
