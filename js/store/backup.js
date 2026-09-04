// Full local-database backup: pack everything (folders, sessions -- text,
// recordings, reference clips, scores -- and deletion tombstones) into a
// single downloadable file, and read one back in. Built on top of
// exportAll()/restoreSnapshot() (snapshot.js) and the app's own tiny ZIP
// reader/writer (../zip.js); the file is a plain ZIP saved with a distinct
// ".tuner" extension (see history-panel/panel.js) purely so double-clicking
// it, or picking it in a file dialog, can't be confused with an arbitrary
// .zip a user meant to unpack normally.

import { makeZip, readZip } from '../zip.js';
import { exportAll, restoreSnapshot } from './snapshot.js';

const FORMAT_VERSION = 1;

const MIME_FOR_EXT = { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', bin: 'application/octet-stream' };
function extForMime(type) {
  if (type === 'audio/wav') return 'wav';
  if (type === 'audio/mpeg') return 'mp3';
  if (type === 'audio/ogg') return 'ogg';
  return 'bin';
}
function extOf(path) {
  return path ? path.slice(path.lastIndexOf('.') + 1) : null;
}

/**
 * Build the full-backup ZIP: manifest.json (folders, tombstones, and every
 * session's fields with each sentence's recordingBlob/referenceBlob replaced
 * by a file reference) plus one file per recording/reference clip actually
 * present. Returns a ZIP Blob ready to download.
 */
export async function buildBackupZip() {
  const { folders, sessions, tombstones } = await exportAll();
  const files = [];
  const manifestSessions = [];

  for (const session of sessions) {
    const sentencesOut = [];
    for (const s of session.sentences || []) {
      const entry = {
        id: s.id,
        text: s.text,
        lang: s.lang,
        hidden: s.hidden,
        updatedAt: s.updatedAt || null,
        recordingHash: s.recordingHash || null,
        referenceHash: s.referenceHash || null,
        referenceSource: s.referenceSource || null,
        assessment: s.assessment || null,
        assessmentHash: s.assessmentHash || null,
        recordingFile: null,
        referenceFile: null,
      };
      if (s.recordingBlob) {
        const path = `audio/${session.id}/${s.id}.recording.${extForMime(s.recordingBlob.type)}`;
        entry.recordingFile = path;
        files.push({ name: path, data: new Uint8Array(await s.recordingBlob.arrayBuffer()) });
      }
      if (s.referenceBlob) {
        const path = `audio/${session.id}/${s.id}.reference.${extForMime(s.referenceBlob.type)}`;
        entry.referenceFile = path;
        files.push({ name: path, data: new Uint8Array(await s.referenceBlob.arrayBuffer()) });
      }
      sentencesOut.push(entry);
    }
    manifestSessions.push({
      id: session.id,
      folderId: session.folderId ?? null,
      name: session.name ?? null,
      inputText: session.inputText || '',
      inputTextHash: session.inputTextHash || null,
      splitMode: session.splitMode,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      metaUpdatedAt: session.metaUpdatedAt || session.updatedAt || session.createdAt || 0,
      sentences: sentencesOut,
    });
  }

  const manifest = {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    folders: (folders || []).map((f) => ({
      id: f.id, name: f.name, parentId: f.parentId ?? null, createdAt: f.createdAt, updatedAt: f.updatedAt,
    })),
    tombstones: tombstones || [],
    sessions: manifestSessions,
  };
  files.unshift({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest)) });

  return makeZip(files);
}

/**
 * Parse a .tuner backup's ArrayBuffer back into the shape
 * store.restoreSnapshot() expects -- mirrors restoreFromAzure() in
 * sync/azure-sync.js, minus the network calls. Throws with a message safe to
 * show the user on anything that isn't a backup this app produced.
 */
export async function parseBackupZip(arrayBuffer) {
  const entries = readZip(arrayBuffer);
  const byName = new Map(entries.map((e) => [e.name, e.data]));

  const manifestBytes = byName.get('manifest.json');
  if (!manifestBytes) throw new Error('Not a valid .tuner backup (missing manifest.json).');
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (manifest.formatVersion !== FORMAT_VERSION) {
    throw new Error(`Unsupported .tuner backup format version: ${manifest.formatVersion}`);
  }

  const sessions = (manifest.sessions || []).map((session) => ({
    id: session.id,
    folderId: session.folderId ?? null,
    name: session.name ?? null,
    inputText: session.inputText || '',
    inputTextHash: session.inputTextHash || null,
    splitMode: session.splitMode,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    metaUpdatedAt: session.metaUpdatedAt || session.updatedAt || session.createdAt || 0,
    sentences: (session.sentences || []).map((s) => {
      const recordingBytes = s.recordingFile ? byName.get(s.recordingFile) : null;
      const referenceBytes = s.referenceFile ? byName.get(s.referenceFile) : null;
      return {
        id: s.id,
        text: s.text,
        lang: s.lang,
        hidden: s.hidden,
        assessment: s.assessment || null,
        recordingBlob: recordingBytes
          ? new Blob([recordingBytes], { type: MIME_FOR_EXT[extOf(s.recordingFile)] || 'application/octet-stream' })
          : null,
        recordingHash: s.recordingHash || null,
        assessmentHash: s.assessmentHash || null,
        referenceBlob: referenceBytes
          ? new Blob([referenceBytes], { type: MIME_FOR_EXT[extOf(s.referenceFile)] || 'application/octet-stream' })
          : null,
        referenceHash: s.referenceHash || null,
        referenceSource: s.referenceSource || null,
        updatedAt: s.updatedAt || session.updatedAt || session.createdAt || 0,
      };
    }),
  }));

  return {
    folders: manifest.folders || [],
    sessions,
    tombstones: manifest.tombstones || [],
  };
}

/**
 * Bump every session/sentence/folder in a parsed backup to look like it was
 * just edited, right now -- without this, importing an OLDER backup over a
 * currently-configured cloud sync is a no-op in practice: cloud sync merges
 * last-write-wins by `updatedAt`/`metaUpdatedAt` (see mergeSession() /
 * mergeSentences() in sync/merge.js), so the very next sync after Import
 * would see Azure's copy as newer and silently overwrite the just-restored
 * data right back with whatever was on Azure before the import.
 *
 * `createdAt` is left untouched (Import isn't creating anything new); only
 * the "last touched" signals move, so this import wins any merge against
 * whatever is currently on Azure, the same as if every session/sentence/
 * folder had actually been hand-edited just now. Tombstones are left as-is
 * (they only decide whether an already-deleted item stays deleted, which
 * this isn't touching).
 */
export function freshenImportTimestamps(snapshot) {
  const now = Date.now();
  return {
    folders: (snapshot.folders || []).map((f) => ({ ...f, updatedAt: now })),
    tombstones: snapshot.tombstones || [],
    sessions: (snapshot.sessions || []).map((session) => ({
      ...session,
      updatedAt: now,
      metaUpdatedAt: now,
      sentences: (session.sentences || []).map((s) => ({ ...s, updatedAt: now })),
    })),
  };
}

/** Restore local IndexedDB from a parsed backup -- thin re-export so callers
 *  (history-panel/panel.js) only need to import from this one module. */
export { restoreSnapshot };
