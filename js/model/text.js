// Text rules: splitting a block of text into practice sentences, and reducing a
// word or phrase to the key its vocabulary entry is stored under.
//
// Both are pure and both are decisions about meaning rather than mechanics,
// which is why they live in model/ rather than beside the UI that calls them.

// Terminal punctuation, full-width (。．！？…) and half-width (. ! ?). A
// half-width period only terminates when followed by whitespace or the end of
// the line, which keeps a decimal ("3.5") and a mid-token abbreviation ("U.S"
// in "U.S.A") intact.
//
// Known limitation, accepted: an abbreviation whose own final period is
// followed by a space does split -- "Mr. Smith" becomes two sentences, and so
// does the "U.S." in "the U.S. today". Recognising those needs an abbreviation
// list, which would be English-only, incomplete, and would still mis-split the
// Japanese text this app is mostly used for. A wrong split is also cheap to
// recover from here: the sentence list is editable, and Merge rejoins two
// pieces losslessly.
//
// Built fresh per call rather than shared at module level. A global regex
// carries `lastIndex` between uses, so a shared one has to be reset before
// every loop and silently returns wrong matches if two callers ever interleave.
const terminators = () => /([。．！？!?…]+|\.(?=\s|$))/g;

/**
 * Split text into sentences, keeping the punctuation that ended each one.
 *
 * A newline is a hard separator regardless of punctuation: a line that ends
 * without any is still its own sentence, because that is how pasted text
 * (headings, lyrics, a list) is actually laid out.
 *
 * @param {string} text
 * @returns {string[]} Trimmed, with empties dropped.
 */
export function segmentText(text) {
  if (!text) return [];
  const sentences = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let cut = 0;
    for (const match of trimmed.matchAll(terminators())) {
      const end = match.index + match[0].length;
      const piece = trimmed.slice(cut, end).trim();
      if (piece) sentences.push(piece);
      cut = end;
    }
    const tail = trimmed.slice(cut).trim();
    if (tail) sentences.push(tail);
  }

  return sentences;
}

/**
 * Which of the app's two languages a piece of text is in.
 *
 * Any kana or CJK character means Japanese; anything else is English. That is
 * the whole rule, and it is right for what it is used for -- labelling freshly
 * split text so the correct voice reads it back. A sentence it gets wrong is
 * one toggle away from being right, which is a better trade than a heavier
 * detector that is wrong in less obvious ways.
 *
 * @returns {'ja'|'en'}
 */
export function detectLang(text) {
  return /[぀-ヿ㐀-䶿一-鿿豈-﫿]|[\u{20000}-\u{2ffff}]/u.test(text || '') ? 'ja' : 'en';
}

// A character that belongs inside a written word: Latin letters and digits.
// Kana and Han are deliberately excluded -- Japanese is written without spaces,
// so counting its characters as word-internal would leave such a sentence with
// no cut positions at all, which is precisely where per-character positions are
// wanted.
const WORD_CHAR = /[\p{Script=Latin}\p{Number}]/u;
const SPACE = /\s/u;

/**
 * Whether a sentence may be cut between `before` and `after` when there is no
 * audio timing to say where the words actually are.
 *
 * Japanese gets every position between two characters, because that is where a
 * cut can legitimately fall. English gets word starts only: nobody cuts inside
 * "sentence", and offering a position per letter buries the few worth having.
 * A cut there must follow whitespace, which also keeps it off the end of a word
 * and off its trailing punctuation -- splitText leaves the whitespace with the
 * left half, so the right half begins with the next word.
 *
 * Mixed text falls out of the same rule rather than being special-cased:
 * "この PDF を" offers the positions on either side of PDF and none inside it.
 *
 * @param {string} before The character to the left of the position.
 * @param {string} after The character to the right of it.
 */
export function canCutBetween(before, after) {
  if (SPACE.test(after)) return false;
  if (SPACE.test(before)) return true;
  return !WORD_CHAR.test(before) && !WORD_CHAR.test(after);
}

/**
 * The key a vocabulary entry is stored under: whitespace, punctuation and
 * symbols removed, lowercased. "Hello, world!" and "hello world" are therefore
 * the same entry, and so are a word picked with and without its trailing
 * comma.
 *
 * Returns '' for input that reduces to nothing (pure punctuation). Callers must
 * treat that as "not a word" and refuse it rather than storing an entry under
 * an empty key.
 */
export function vocabKey(text) {
  return (text || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}
