// Pure word-segmentation/grouping calculations for the "记录生词" picker
// (vocab-picker.js) -- no DOM, no store, no state.js, so this is safely
// unit-testable directly in Node, same reasoning as split-geometry.js.

/**
 * Word spans for a sentence with no real per-word timing data: the same
 * English-space / Japanese-per-character convention split-geometry.js's
 * textSplitPoints() uses for split triangles, just returning whole word
 * SPANS (charStart/charEnd pairs) here instead of boundary points, since the
 * picker needs clickable units, not split positions.
 */
function fallbackWordUnits(sentence) {
  const chars = Array.from(sentence.text);
  const units = [];
  if (sentence.lang === 'ja') {
    for (let i = 0; i < chars.length; i++) {
      if (!/\s/.test(chars[i])) units.push({ charStart: i, charEnd: i + 1 });
    }
  } else {
    let i = 0;
    while (i < chars.length) {
      if (/\s/.test(chars[i])) { i++; continue; }
      let j = i;
      while (j < chars.length && !/\s/.test(chars[j])) j++;
      units.push({ charStart: i, charEnd: j });
      i = j;
    }
  }
  return units;
}

/** The clickable word units for `sentence`'s picker -- real Azure word spans
 *  (sentence.words, already shaped as charStart/charEnd/offsetMilliseconds/
 *  durationMilliseconds entries) when available, the text-only fallback
 *  split otherwise. In practice the "记录生词" button (row.js) is only
 *  enabled once sentence.words exists, so the fallback branch here mainly
 *  keeps this module correct/self-contained on its own, not a path reachable
 *  through the button today. */
export function wordUnitsForSentence(sentence) {
  if (sentence.words && sentence.words.length) return sentence.words;
  return fallbackWordUnits(sentence);
}

/**
 * Group selected unit INDICES into runs of consecutive indices -- two
 * selected words with nothing but a space (or, for Japanese, nothing at all)
 * between them are "adjacent" per Aspen's own rule ("如果选中的多个词是相邻的
 * 则作为一个整体看待，否则作为两个独立的项目看待"); indices, not literal
 * character-adjacency, is what "adjacent in the word sequence" means here.
 * Returns an array of unit arrays, one per group, in ascending order.
 */
export function groupContiguousSelection(selectedIndices, units) {
  const sorted = [...selectedIndices].sort((a, b) => a - b);
  const groups = [];
  let current = [];
  for (const idx of sorted) {
    if (current.length && idx === current[current.length - 1] + 1) {
      current.push(idx);
    } else {
      if (current.length) groups.push(current);
      current = [idx];
    }
  }
  if (current.length) groups.push(current);
  return groups.map((idxs) => idxs.map((i) => units[i]));
}
