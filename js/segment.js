// Sentence splitting: split on Japanese (。！？) and English (.!?) terminal
// punctuation, keeping the punctuation.
// Goal: robust enough for mixed text while staying simple and auditable.

// Terminal punctuation: full-width 。！？… (CJK) and half-width . ! ?
// Note: an English period also breaks abbreviations (e.g. Mr. / U.S.); this is
// handled minimally here — a richer abbreviation dictionary can be added later.
const TERMINATORS = /([。．！？!?…]+|\.(?=\s|$))/g;

/**
 * Split a block of text into an array of sentences.
 * - keeps terminal punctuation
 * - also splits on newlines (a newline is a hard separator)
 * - trims whitespace and drops empty sentences
 * @param {string} text
 * @returns {string[]}
 */
export function segment(text) {
  if (!text) return [];

  const sentences = [];

  // Split into paragraphs by newline first, then split each by terminal punctuation.
  for (const line of text.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    let buffer = '';
    let lastIndex = 0;
    let match;

    TERMINATORS.lastIndex = 0;
    while ((match = TERMINATORS.exec(trimmedLine)) !== null) {
      const end = match.index + match[0].length;
      buffer = trimmedLine.slice(lastIndex, end);
      const cleaned = buffer.trim();
      if (cleaned) sentences.push(cleaned);
      lastIndex = end;
    }

    // Any trailing remainder without punctuation counts as a sentence too.
    const tail = trimmedLine.slice(lastIndex).trim();
    if (tail) sentences.push(tail);
  }

  return sentences;
}
