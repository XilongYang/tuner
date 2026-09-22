// Where a session sits in the library list.
//
// The list is arranged by hand and stays arranged: nothing re-sorts it behind
// the user's back, so a rename does not move a row and neither does a save.
// That rules out deriving the order from any field that changes on its own
// (updatedAt did exactly that, which is why opening a session used to make it
// jump to the top the next time the library was opened).
//
// Position is a per-session key, and rows are read in ascending key order. A
// key is *not* an index: an index makes moving one row a rewrite of every row
// below it, and on two devices that is a write conflict over records neither
// person touched -- a reorder here would silently undo a rename there. A key
// that can always be subdivided makes a move a change to exactly one record,
// which is the one record whose position the user actually changed, so last
// write wins is applied to the right thing.
//
// Keys are strings compared as strings, read as digits after an implied "0.":
// "i" is the middle of the range, "a" is before it, "z9" after "z". Between any
// two distinct keys there is always another one, so no arrangement can run out
// of room -- the keys just get longer, a digit at a time, and only for the rows
// being squeezed.

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * A key strictly between `lower` and `upper`.
 *
 * `null` for either end means "no bound that way": `between(null, null)` is a
 * key for an empty list, `between(null, first)` puts a row at the top.
 *
 * @param {string|null} lower
 * @param {string|null} upper
 */
export function between(lower, upper) {
  const a = lower ?? '';
  const b = upper ?? null;
  if (b !== null && a >= b) throw new Error(`Order keys out of sequence: ${JSON.stringify(a)} is not before ${JSON.stringify(b)}`);
  // A key ending in the lowest digit has no room below it at that length, and
  // the subdivision below quietly returns a key past the upper bound for one.
  // Nothing here ever produces such a key -- the midpoint of a range never
  // lands on the first digit -- so one can only arrive from outside, and a
  // refusal is the right answer to a key this cannot reason about. Silently
  // misplacing the row is not.
  for (const key of [a, b]) {
    if (typeof key === 'string' && key.endsWith(DIGITS[0])) {
      throw new Error(`Order key cannot be subdivided: ${JSON.stringify(key)} ends in ${DIGITS[0]}`);
    }
  }
  return midpoint(a, b);
}

function midpoint(a, b) {
  if (b !== null) {
    // The shared prefix is already agreed: only the tails need a value between
    // them, and keeping the prefix is what stops keys growing on every insert.
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }

  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) / 2)];

  // The two are adjacent digits, so there is no room at this length: keep a's
  // digit and find room in what follows it. `b` drops away -- anything longer
  // than a's first digit and starting with it is below b already.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

/** A key for a row that goes above everything in `keys`. */
export const keyBefore = (keys) => between(null, min(keys));

/** A key for a row that goes below everything in `keys`. */
export const keyAfter = (keys) => between(max(keys), null);

const min = (keys) => keys.reduce((low, key) => (low === null || key < low ? key : low), null);
const max = (keys) => keys.reduce((high, key) => (high === null || key > high ? key : high), null);

/**
 * Compare two records by position.
 *
 * The id breaks a tie, and ties are not hypothetical: two devices that both put
 * a new session at the top of the same list compute the same key, because the
 * computation is deterministic and they are looking at the same neighbours.
 * Falling back to the id means both devices then show those two rows in the
 * same order as each other, which matters more than which of them is first.
 *
 * A record with no key at all sorts last rather than first: an unplaced row is
 * one this device has not stamped yet (see db/migrate.js), and the bottom is
 * where it disturbs the least.
 */
export function byOrder(a, b) {
  const keyA = a.sortKey ?? null;
  const keyB = b.sortKey ?? null;
  if (keyA === keyB) return String(a.id).localeCompare(String(b.id));
  if (keyA === null) return 1;
  if (keyB === null) return -1;
  return keyA < keyB ? -1 : 1;
}

/** `records` in list order. Does not mutate the argument. */
export const inOrder = (records) => [...records].sort(byOrder);

/**
 * The key for a row dropped between two others.
 *
 * Both neighbours are given as keys, `null` where there is no row that side, so
 * this is the same call for the top of the list, the bottom, and everywhere in
 * between. The caller has the list on screen and therefore knows the
 * neighbours; nothing here re-derives them.
 */
export function keyForMove({ before = null, after = null }) {
  return between(before, after);
}

/**
 * Keys for a list that has none, in the order given, each below the last.
 *
 * `after` starts the run below a key that is already in use, so a device that
 * has some rows placed and some not can stamp the rest without disturbing the
 * arrangement it already has.
 *
 * Used once, for sessions stored before the list had an arrangement. They are
 * stamped in the order they were being shown at the time, so the first look
 * after the upgrade is the same list in the same order -- an arrangement nobody
 * chose, but not a shuffle either.
 */
export function initialKeys(count, { after = null } = {}) {
  const keys = [];
  let previous = after;
  for (let i = 0; i < count; i += 1) {
    previous = between(previous, null);
    keys.push(previous);
  }
  return keys;
}
