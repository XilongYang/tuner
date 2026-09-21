// Starting, opening, closing and deleting a practice session.
//
// Each of these is a whole workflow, and each lives here exactly once. The
// previous implementation had one of them -- clearing the workspace -- hand
// copied into two other modules, which then drifted: the copies omitted three
// of the eight things the original did, and a restore while an audio session
// was open left the user with no text box and no way back except a button whose
// label no longer made sense.

import { segmentText, detectLang } from '../../model/text.js';
import { blankSentence, derivedInputText, updateSession } from '../../model/session.js';

/**
 * A session with nothing in it.
 *
 * Every field the schema names is set, so a fresh session and one read back
 * from storage have the same shape and nothing downstream has to cope with an
 * absent field.
 */
export function emptySession({ id, now, splitMode = 'auto' }) {
  return {
    id,
    name: null,
    folderId: null,
    splitMode,
    createdAt: now,
    updatedAt: now,
    metaUpdatedAt: now,
    inputText: null,
    inputTextHash: null,
    sourceAudio: null,
    sourceAudioHash: null,
    sentences: [],
  };
}

/**
 * Put a blank session on screen, discarding whatever was there.
 *
 * Callers do not clear the workspace themselves; they call this. Anything
 * holding a lifecycle for the session being discarded -- recorders, playback --
 * is released through `release`, which the composition root supplies.
 */
export function startNew({ store, deps, splitMode = 'auto' }) {
  const { ids, clock, release, autosave } = deps;
  release?.();
  autosave?.reset(null);
  store.replace(emptySession({ id: ids(), now: clock(), splitMode }), 'new-session');
  return { ok: true };
}

/**
 * Whether a sentence being created now should start hidden.
 *
 * The global switch says how this person is practising, and that has to hold
 * for sentences made from here on -- otherwise the next Split quietly undoes
 * it. Lives here, and is used by every command that creates sentences, because
 * one rule in two places is how the previous implementation drifted.
 */
export const startsHidden = (settings) => settings?.hideText?.() ?? false;

/**
 * Split typed text into sentences and make them the session on screen.
 *
 * The session keeps the text as typed: it is what the user will edit if they
 * split again, and unlike an imported session there is nothing else to derive
 * it from.
 *
 * Each sentence's language is detected from its own text rather than one being
 * chosen for the whole block, because a pasted lesson is regularly both -- a
 * Japanese line and its English gloss -- and a sentence read back in the wrong
 * voice is the first thing a user notices. `lang` overrides that where the
 * caller knows better.
 */
export function splitTypedText({ store, text, lang = null, deps }) {
  const { ids, clock, settings } = deps;
  const pieces = segmentText(text);
  if (!pieces.length) return { ok: false, reason: 'no-text' };

  const now = clock();
  const hidden = startsHidden(settings);
  const sentences = pieces.map((piece) => blankSentence({
    id: ids(), text: piece, lang: lang ?? detectLang(piece), now, hidden,
  }));

  store.apply((current) => ({
    ...(current ?? emptySession({ id: ids(), now })),
    splitMode: 'auto',
    inputText: text,
    sentences,
    updatedAt: now,
    metaUpdatedAt: now,
  }), 'split-text');

  return { ok: true, count: sentences.length };
}

/**
 * Open a stored session.
 *
 * The stored record goes on screen as it is -- there is one session shape, so
 * nothing is converted. Autosave is told what the stored copy looks like, so
 * the next save can skip re-reading content that has not changed.
 */
export async function open({ store, sessionId, deps }) {
  const { db, release, autosave, settings } = deps;

  const stored = await db.getOne('sessions', sessionId);
  if (!stored) return { ok: false, reason: 'not-found' };

  release?.();
  autosave?.reset(stored);
  store.replace(stored, 'opened');
  settings?.saveLastSessionId(sessionId);

  return { ok: true, session: stored };
}

/**
 * Reopen whatever was last on screen, at startup.
 *
 * A session that has since been deleted is not an error: the user simply gets a
 * blank one, which is where they would have ended up anyway.
 */
export async function reopenLast({ store, deps }) {
  const { settings } = deps;
  const id = settings?.lastSessionId();
  if (!id) return startNew({ store, deps });

  const result = await open({ store, sessionId: id, deps });
  if (result.ok) return result;

  settings?.saveLastSessionId(null);
  return startNew({ store, deps });
}

/** Rename, or move to a folder. Both change the session's own fields. */
export function describe({ store, patch, deps }) {
  const { clock } = deps;
  const changed = store.apply((current) => (current ? updateSession(current, patch, clock()) : null), 'describe');
  return { ok: changed };
}

/**
 * Delete a stored session.
 *
 * The record and its tombstone are written together by the database, so the
 * deletion cannot be local-only and come straight back on the next sync. If the
 * deleted session is the one on screen, the screen moves to a blank one -- the
 * alternative is leaving the user editing something that no longer exists.
 */
export async function remove({ store, sessionId, deps }) {
  const { db, settings } = deps;

  await db.remove('sessions', sessionId);
  if (settings?.lastSessionId() === sessionId) settings.saveLastSessionId(null);

  const onScreen = store.get();
  if (onScreen?.id === sessionId) startNew({ store, deps });

  return { ok: true, wasOnScreen: onScreen?.id === sessionId };
}

/**
 * Put a session that arrived from elsewhere on screen, if it is the one being
 * looked at.
 *
 * Used after a sync. Refuses when the screen has moved on, because a session
 * the user has since left is not worth interrupting them for -- and refuses
 * when the local copy is newer, since a sync's own staleness check already
 * declined to write it.
 */
export function applyIncoming({ store, session, deps }) {
  const { autosave } = deps;
  const current = store.get();
  if (!current || current.id !== session.id) return { ok: false, reason: 'not-on-screen' };
  if ((current.updatedAt ?? 0) > (session.updatedAt ?? 0)) return { ok: false, reason: 'local-is-newer' };

  autosave?.reset(session);
  store.replace(session, 'incoming');
  return { ok: true };
}

/** The text a session should be stored with; audio sessions derive theirs. */
export { derivedInputText };
