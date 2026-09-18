// Full local-database backup: pack everything (folders, sessions -- text,
// recordings, reference clips, an audio-imported session's original source
// file, scores -- the vocab library, and deletion tombstones) into a single
// downloadable file, and read one back in. Built on top of
// exportAll()/restoreSnapshot() (snapshot.js) and the app's own tiny ZIP
// reader/writer (../zip.js); the file is a plain ZIP saved with a distinct
// ".tuner" extension (see history-panel/panel.js) purely so double-clicking
// it, or picking it in a file dialog, can't be confused with an arbitrary
// .zip a user meant to unpack normally.

import { makeZip, readZip } from '../zip.js';
import { exportAll, restoreSnapshot } from './snapshot.js';
import {
  FOLDER_FIELDS, FOLDER_OPTIONAL_FIELDS,
  SESSION_FIELDS, SESSION_OPTIONAL_FIELDS,
  SENTENCE_FIELDS, SENTENCE_OPTIONAL_FIELDS,
  VOCAB_ENTRY_FIELDS, VOCAB_SOURCE_FIELDS, VOCAB_SOURCE_OPTIONAL_FIELDS,
  pickFields, sessionMetaUpdatedAt, sentenceUpdatedAt,
} from './entity-schema.js';

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
 * Build the full-backup ZIP: manifest.json (folders, tombstones, vocab, and
 * every session's fields with each sentence's recordingBlob/referenceBlob
 * replaced by a file reference) plus one file per recording/reference/vocab
 * audio clip actually present. Returns a ZIP Blob ready to download.
 */
export async function buildBackupZip() {
  const { folders, sessions, vocab, tombstones } = await exportAll();
  const files = [];
  const manifestSessions = [];

  for (const session of sessions) {
    const sentencesOut = [];
    for (const s of session.sentences || []) {
      const entry = {
        ...pickFields(s, SENTENCE_FIELDS, SENTENCE_OPTIONAL_FIELDS),
        // Azure's per-word timestamps + any manually-confirmed split points
        // (state.js's doc comment), and the score itself -- plain JSON,
        // added additively so an OLDER app version reading a backup made by
        // this one just ignores these extra keys, and this version reading
        // an OLDER backup gets `null` (same as "none yet") for all of them.
        // No FORMAT_VERSION bump needed for either direction.
        assessment: s.assessment || null,
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

    // The original audio an import-mode session was sliced from (state.js's
    // sourceAudioBlob) -- one file per session, packed the same way a
    // recording/reference clip is, so Split/Merge can keep re-slicing
    // losslessly from it after a restore too.
    let sourceAudioFile = null;
    if (session.sourceAudioBlob) {
      sourceAudioFile = `audio/${session.id}/source.${extForMime(session.sourceAudioBlob.type)}`;
      files.push({ name: sourceAudioFile, data: new Uint8Array(await session.sourceAudioBlob.arrayBuffer()) });
    }

    manifestSessions.push({
      ...pickFields(session, SESSION_FIELDS, SESSION_OPTIONAL_FIELDS),
      inputText: session.inputText || '',
      metaUpdatedAt: sessionMetaUpdatedAt(session),
      sentences: sentencesOut,
      sourceAudioFile,
    });
  }

  // Vocab library (js/store/vocab.js): each entry's occurrences pack the same
  // way a sentence's recording/reference does -- one file per occurrence
  // that actually has audio, referenced from the manifest by path, keyed by
  // the entry's own audioPathKey + occurrenceId (mirroring
  // sync/blob-paths.js's blobVocabAudioPath(), just as files in a ZIP
  // instead of blobs on Azure) rather than a session/sentence id, since an
  // occurrence's source session/sentence may not even exist anymore.
  const manifestVocab = [];
  for (const entry of vocab || []) {
    const sourcesOut = [];
    for (const s of entry.sources || []) {
      const out = {
        ...pickFields(s, VOCAB_SOURCE_FIELDS, VOCAB_SOURCE_OPTIONAL_FIELDS),
        audioFile: null,
      };
      if (s.audioBlob) {
        const path = `audio/vocab/${entry.audioPathKey}/${s.occurrenceId}.${extForMime(s.audioBlob.type)}`;
        out.audioFile = path;
        files.push({ name: path, data: new Uint8Array(await s.audioBlob.arrayBuffer()) });
      }
      sourcesOut.push(out);
    }
    manifestVocab.push({
      ...pickFields(entry, VOCAB_ENTRY_FIELDS),
      sources: sourcesOut,
    });
  }

  const manifest = {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    folders: (folders || []).map((f) => pickFields(f, FOLDER_FIELDS, FOLDER_OPTIONAL_FIELDS)),
    tombstones: tombstones || [],
    // Additive, like words/manualPoints above -- an OLDER app version reading
    // a backup made by this one just ignores this key; this version reading
    // an OLDER backup (no `vocab` key at all) gets `[]` in parseBackupZip()
    // below, same as "no vocab library yet". No FORMAT_VERSION bump needed.
    vocab: manifestVocab,
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

  const sessions = (manifest.sessions || []).map((session) => {
    const sourceAudioBytes = session.sourceAudioFile ? byName.get(session.sourceAudioFile) : null;
    return {
      ...pickFields(session, SESSION_FIELDS, SESSION_OPTIONAL_FIELDS),
      inputText: session.inputText || '',
      metaUpdatedAt: sessionMetaUpdatedAt(session),
      sourceAudioBlob: sourceAudioBytes
        ? new Blob([sourceAudioBytes], { type: MIME_FOR_EXT[extOf(session.sourceAudioFile)] || 'application/octet-stream' })
        : null,
      sentences: (session.sentences || []).map((s) => {
        const recordingBytes = s.recordingFile ? byName.get(s.recordingFile) : null;
        const referenceBytes = s.referenceFile ? byName.get(s.referenceFile) : null;
        return {
          ...pickFields(s, SENTENCE_FIELDS, SENTENCE_OPTIONAL_FIELDS),
          assessment: s.assessment || null,
          recordingBlob: recordingBytes
            ? new Blob([recordingBytes], { type: MIME_FOR_EXT[extOf(s.recordingFile)] || 'application/octet-stream' })
            : null,
          referenceBlob: referenceBytes
            ? new Blob([referenceBytes], { type: MIME_FOR_EXT[extOf(s.referenceFile)] || 'application/octet-stream' })
            : null,
          updatedAt: sentenceUpdatedAt(s, session),
        };
      }),
    };
  });

  const vocab = (manifest.vocab || []).map((entry) => ({
    ...pickFields(entry, VOCAB_ENTRY_FIELDS),
    sources: (entry.sources || []).map((s) => {
      const audioBytes = s.audioFile ? byName.get(s.audioFile) : null;
      return {
        ...pickFields(s, VOCAB_SOURCE_FIELDS, VOCAB_SOURCE_OPTIONAL_FIELDS),
        hasAudio: !!audioBytes,
        audioBlob: audioBytes
          ? new Blob([audioBytes], { type: MIME_FOR_EXT[extOf(s.audioFile)] || 'application/octet-stream' })
          : null,
      };
    }),
  }));

  return {
    folders: manifest.folders || [],
    sessions,
    vocab,
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
    // Vocab entries merge by unioning sources[] (mergeVocabEntry() in
    // sync/merge.js), not last-write-wins, so this isn't needed to avoid
    // data loss the way it is for sessions below -- but it's still needed to
    // "un-delete" a vocab entry this backup has that was since deleted (by a
    // tombstone) on whatever this device syncs with next, same resurrection
    // rule survivesTombstone() applies everywhere else.
    vocab: (snapshot.vocab || []).map((entry) => ({ ...entry, updatedAt: now })),
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
