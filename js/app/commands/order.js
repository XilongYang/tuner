// Arranging the library list.
//
// Two operations, and between them they are the only things that ever decide
// where a session sits: a session is placed once, when it is first stored, and
// moved when the user drags it. Nothing else touches `sortKey` -- that is what
// "no automatic sorting" means in code rather than in a comment.
//
// The math is model/order.js's; this is the part that has to read the list to
// know what the neighbours are.

import { between, inOrder } from '../../model/order.js';

/**
 * Sessions in the order the library shows them.
 *
 * Read without content: a list of names and counts does not need the audio,
 * and hydrating it reads every recording in the library to draw one panel.
 */
export async function listOrdered({ db }) {
  return inOrder(await db.listAll('sessions', { content: false }));
}

/**
 * Give a record a place if it has none: the top of the list.
 *
 * Called on the way to storage, so a session is placed at the moment it becomes
 * something the library can show -- not when it was created, which for a
 * session typed into an empty workspace is several minutes and one split
 * earlier. A record that already has a key is returned untouched, so this costs
 * one read on a session's first save and nothing on the thousands after it.
 */
export async function placeNew({ db, record }) {
  if ((record?.sortKey ?? null) !== null) return record;

  const existing = await db.listAll('sessions', { content: false });
  const first = inOrder(existing)[0] ?? null;
  return { ...record, sortKey: between(null, first?.sortKey ?? null) };
}

/**
 * Move a session to sit between two others.
 *
 * The caller gives the ids of the rows it will land between -- whichever it has
 * on screen -- and `null` where there is no row on that side. Reading the
 * neighbours' keys here rather than taking them from the caller keeps a stale
 * list from writing a position that was true a sync ago.
 *
 * @returns {Promise<{ok: boolean, reason?: string, sortKey?: string}>}
 */
export async function moveSession({ db, clock, sessionId, beforeId = null, afterId = null }) {
  const sessions = await db.listAll('sessions', { content: false });
  const moving = sessions.find((session) => session.id === sessionId);
  if (!moving) return { ok: false, reason: 'not-found' };

  const keyOf = (id) => (id === null ? null : sessions.find((session) => session.id === id)?.sortKey ?? null);
  const before = keyOf(beforeId);
  const after = keyOf(afterId);

  // Either neighbour may have been deleted or moved on another device since the
  // list was drawn. Dropping the pair and re-reading would land the row
  // somewhere the user did not point at, so the move is refused and the caller
  // refreshes -- an honest "that list was stale" beats a silent misplacement.
  if ((beforeId !== null && before === null) || (afterId !== null && after === null)) {
    return { ok: false, reason: 'stale' };
  }
  if (before !== null && after !== null && before >= after) return { ok: false, reason: 'stale' };

  // Already sitting between those two: dropping a row back where it was is a
  // no-op, and giving it a fresh key anyway would bump its clock, upload it,
  // and make a change on another device lose to a move nobody made.
  const here = moving.sortKey ?? null;
  if (here !== null && (before === null || here > before) && (after === null || here < after)) {
    return { ok: true, sortKey: here };
  }

  const sortKey = between(before, after);

  const now = clock();
  // metaUpdatedAt, because a position is one of the session's own fields: a
  // move made here has to outrank the position another device is holding, and
  // has no business outranking an edit to a sentence.
  await db.put('sessions', { ...moving, sortKey, updatedAt: now, metaUpdatedAt: now });
  return { ok: true, sortKey };
}
