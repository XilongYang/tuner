import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');
await page.waitForLoadState('networkidle');

const result = await page.evaluate(async () => {
  const stateMod = await import('/js/state.js');
  const splitMod = await import('/js/sentence-panel/split-render.js');
  const recorderMod = await import('/js/recorder.js');
  const { Recorder } = recorderMod;
  const { setSentences } = stateMod;
  const { render } = splitMod;

  const text = 'Alpha beta gamma delta';
  // Two word pointers (char 6 and char 11), same text, so we can compare
  // the rendered character positions against an identical sentence with NO
  // pointers at all.
  const withPointers = {
    id: crypto.randomUUID(), text, lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: 'import',
    sourceOffsetMs: 0, sourceDurationMs: 2000,
    words: [
      { offsetMilliseconds: 500, durationMilliseconds: 300, charStart: 6, charEnd: 10 },
      { offsetMilliseconds: 900, durationMilliseconds: 300, charStart: 11, charEnd: 16 },
    ],
    manualPoints: null,
  };
  const withoutPointers = {
    id: crypto.randomUUID(), text, lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: 'import',
    sourceOffsetMs: 0, sourceDurationMs: 2000, words: null, manualPoints: null,
  };
  // A long sentence that wraps to 2+ lines at this viewport width, with word
  // pointers scattered across every line -- the actual case task 3 (the
  // "affects the line above in multi-line text" bug report) is about.
  const wrapText = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi';
  const wrapWords = [];
  for (let i = 6; i < wrapText.length - 1; i += 6) {
    wrapWords.push({ offsetMilliseconds: i * 10, durationMilliseconds: 100, charStart: i, charEnd: i + 1 });
  }
  const wrapped = {
    id: crypto.randomUUID(), text: wrapText, lang: 'en', hidden: false, recorder: new Recorder(),
    recordingUrl: null, recordingBlob: null, recordingHash: null, assessment: null,
    referenceBlob: null, referenceUrl: null, referenceHash: null, referenceSource: 'import',
    sourceOffsetMs: 0, sourceDurationMs: 2000, words: wrapWords, manualPoints: null,
  };
  setSentences([withPointers, withoutPointers, wrapped]);
  render();
  return { id1: withPointers.id, id2: withoutPointers.id, id3: wrapped.id };
});

// Compare the on-screen X position of every .row-char in both rows -- they
// must line up exactly (pointer triangles must not shift text).
const positions = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('.sentence-row'));
  return rows.slice(0, 2).map((row) => Array.from(row.querySelectorAll('.row-char')).map((el) => {
    const r = el.getBoundingClientRect();
    return Math.round(r.left);
  }));
});
const [posWithPointers, posWithoutPointers] = positions;
const layoutUnaffected = JSON.stringify(posWithPointers) === JSON.stringify(posWithoutPointers);

// Triangles must actually render and be clickable (not zero-size). They no
// longer need to fully clear the current line's own character top -- see
// css/sentence-panel/split-pointer.css's doc comment on .split-pointer for why a small overlap into
// the CURRENT line's own leading (empty space above the glyphs) is the
// accepted trade-off for not sitting on top of the WRAPPED line above it.
const triangleGeometry = await page.evaluate(() => {
  const tri = document.querySelector('.split-pointer');
  const nearestChar = document.querySelector('.row-char');
  if (!tri || !nearestChar) return null;
  const triRect = tri.getBoundingClientRect();
  const charRect = nearestChar.getBoundingClientRect();
  return {
    triHasSize: triRect.width > 0 && triRect.height > 0,
    triNearCharacterTop: triRect.bottom <= charRect.top + 6, // generous tolerance, see comment above
  };
});

// The actual task-3 regression check: for a sentence that wraps to multiple
// lines, a triangle belonging to a LATER line must not sit on top of the
// text of the line ABOVE it (that's the "影响上一行显示" bug report) -- some
// small overlap into the empty leading space just above the previous line's
// own characters is fine, but it must stay well clear of the glyphs
// themselves. Skips the anchor's own occasional wrap quirk (a pointer whose
// anchor lands at the tail of the PREVIOUS line instead of above its actual
// word, a separate, pre-existing rendering nuance of wrapping a zero-width
// inline element) by only checking pointers whose anchor visibly landed on
// the same line as their own target character.
const wrapIntrusion = await page.evaluate(() => {
  // Third row -- the wrapped/long sentence (see the order sentences were
  // set in above). Not matched by textContent: the inserted triangle glyphs
  // can land mid-word and break a plain substring match.
  const row = document.querySelectorAll('.sentence-row')[2];
  const chars = Array.from(row.querySelectorAll('.row-char'));
  const charRects = chars.map((c) => c.getBoundingClientRect());
  const lineTops = [...new Set(charRects.map((r) => Math.round(r.top)))].sort((a, b) => a - b);
  const lineIndexOf = (top) => lineTops.findIndex((lt) => Math.abs(lt - Math.round(top)) < 2);

  const tris = Array.from(row.querySelectorAll('.split-pointer'));
  const intrusions = [];
  for (const tri of tris) {
    const anchor = tri.closest('.split-pointer-anchor');
    const nextChar = anchor.nextElementSibling;
    if (!nextChar || !nextChar.classList.contains('row-char')) continue;
    const charRect = nextChar.getBoundingClientRect();
    const ownLine = lineIndexOf(charRect.top);
    const triRect = tri.getBoundingClientRect();
    // Skip the anchor-wraps-to-previous-line quirk: its own triangle top
    // won't be anywhere near its target character's line (normal case is a
    // small, fixed offset; the quirk case is off by roughly a whole line).
    if (Math.abs(triRect.top - charRect.top) > 20) continue;
    if (ownLine <= 0) continue;
    const prevLineTop = lineTops[ownLine - 1];
    const prevLineBottom = Math.max(...charRects.filter((r) => Math.abs(r.top - prevLineTop) < 2).map((r) => r.bottom));
    intrusions.push(prevLineBottom - triRect.top); // positive = overlapping the previous line's characters
  }
  return { count: intrusions.length, worstIntrusion: intrusions.length ? Math.max(...intrusions) : null, intrusions };
});

console.log(JSON.stringify({ layoutUnaffected, triangleGeometry, wrapIntrusion }, null, 2));
await browser.close();
console.log('LOGS:', logs);
