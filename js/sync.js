// Cloud backup (Azure Blob Storage): the blob-panel UI, the sync/restore
// status indicators, the manifest + per-field content-addressed merge, the
// automatic sync scheduler (debounce + heartbeat + cross-tab lock), and
// syncWithAzure()/restoreFromAzure() themselves.

import * as store from './store.js';
import * as blobStore from './azure-blob.js';
import {
  loadBlobSasUrl,
  saveBlobSasUrl,
  clearBlobSasUrl,
  hasBlobSasUrl,
} from './config.js';
import {
  els,
  sentences,
  setSentences,
  currentSessionId,
  setCurrentSessionId,
  formatDate,
  isSessionBusy,
} from './state.js';
import { render } from './sentence-panel.js';
import { applyIncomingSessionUpdate, refreshHistoryTreeIfOpen } from './history-panel.js';

// ---- Cloud backup (Azure Blob Storage) ----

// Two mutually exclusive states: has a SAS URL -> one-line status + Clear;
// no SAS URL -> input field + Save. Mirrors updateKeyPanel().
function updateBlobPanel() {
  const url = loadBlobSasUrl();
  const has = !!url;
  els.blobEntry.hidden = has;
  els.blobSaved.hidden = !has;
  if (has) {
    let host = url;
    try { host = new URL(url).hostname; } catch { /* keep raw value if unparsable */ }
    els.blobStatus.textContent = `SAS URL saved \u00b7 ${host}`;
  }
  // The header indicator only exists once cloud sync is configured at all;
  // hidden -> shown here, never the reverse (Clear SAS URL below un-configures
  // it again). A freshly-shown indicator starts in "syncing" state since
  // saving a SAS URL immediately kicks off a sync (see initBlobPanel()).
  els.syncIndicator.hidden = !has;
  if (has) updateSyncIndicator('Starting sync\u2026', 'info');
}

// Timestamp of the last sync that completed successfully (kind 'recording'),
// shown in the "Synced" tooltip. In-memory only -- resets on reload, same as
// manifestEtagCache; the next sync completing fills it back in within seconds.
let lastSyncAt = null;

/**
 * Drives the header's compact sync indicator (dot + one of exactly three
 * words: Synced / Syncing / Sync Failed) from the same (text, kind) pairs
 * setBlobActionStatus() already receives throughout syncWithAzure() and
 * restoreFromAzure() -- no separate state machine, just a different rendering
 * of the same signal. Hover (or focus, for keyboard/touch) reveals `text` in
 * full via the tooltip; for a successful completion, the tooltip also gets a
 * prepended timestamp since the underlying message doesn't carry one.
 */
function updateSyncIndicator(text, kind) {
  const state = kind === 'recording' ? 'synced' : kind === 'error' ? 'failed' : 'syncing';
  els.syncIndicator.dataset.kind = state;
  els.syncIndicatorLabel.textContent = state === 'synced' ? 'Synced' : state === 'failed' ? 'Sync Failed' : 'Syncing';
  if (state === 'synced') {
    lastSyncAt = Date.now();
    const detail = text.replace(/^(Sync|Restore) complete \u2014 /, '');
    els.syncIndicatorTooltip.textContent = `Synced at ${formatDate(lastSyncAt)} \u2014 ${detail}`;
  } else {
    els.syncIndicatorTooltip.textContent = text;
  }
}

function setBlobActionStatus(text, kind) {
  els.blobActionStatus.hidden = !text;
  els.blobActionStatus.textContent = text;
  if (kind) els.blobActionStatus.dataset.kind = kind;
  else delete els.blobActionStatus.dataset.kind;
  // Same underlying signal, rendered differently in the header -- see
  // updateSyncIndicator(). Only meaningful once the indicator is showing at
  // all (i.e. cloud sync is configured), which is exactly when this function
  // is ever called with a non-empty text in the first place.
  if (text) updateSyncIndicator(text, kind);
}


const BLOB_MANIFEST_PATH = 'tuner/manifest.json';

// In-memory cache of the manifest ETag/content we last confirmed matches
// what's on Azure -- lets a heartbeat sync (usually finding nothing changed
// anywhere) skip re-downloading and re-parsing the whole manifest via a
// conditional GET, and skip re-uploading it too when the freshly merged
// result is byte-identical to what's already there. Cleared implicitly on
// page reload (it's just a module-level variable); the first sync after a
// reload pays for one real GET, same as before this existed.
let manifestEtagCache = { etag: null, manifest: null };

const BLOB_RECORDINGS_PREFIX = 'tuner/recordings/';
const blobRecordingPath = (sessionId, sentenceId) => `${BLOB_RECORDINGS_PREFIX}${sessionId}/${sentenceId}.wav`;

// A sentence's assessment (word/phoneme-level scores -- by far the largest
// thing in the old, fully-embedded manifest once anything's been scored) and
// a session's inputText each sync as their own small content-addressed blob,
// exactly like a recording: only a hash lives in the manifest, the actual
// content is fetched separately and only when the merge decides this device
// still needs it (see resolveSentenceContent()/resolveSessionInputText()
// inside syncWithAzure()).
const BLOB_ASSESSMENTS_PREFIX = 'tuner/assessments/';
const blobAssessmentPath = (sessionId, sentenceId) => `${BLOB_ASSESSMENTS_PREFIX}${sessionId}/${sentenceId}.json`;
const BLOB_INPUTTEXT_PREFIX = 'tuner/inputtext/';
const blobInputTextPath = (sessionId) => `${BLOB_INPUTTEXT_PREFIX}${sessionId}.txt`;

/**
 * Delete any blob under `prefix` that the current sync no longer references
 * (e.g. its session was deleted, or a sentence's recording/assessment/a
 * session's inputText was replaced by a newer take since the last sync).
 * Shared by all three content kinds above -- same cleanup logic, just a
 * different prefix and reference set each time. Best-effort: a missing
 * List/Delete permission on the SAS token, or any other failure, is left for
 * the caller to report as a warning rather than fail the whole sync -- the
 * manifest + uploads before this point already succeeded.
 */
async function cleanupOrphanBlobs(sasUrl, prefix, referencedPaths) {
  const allBlobs = await blobStore.listBlobs(sasUrl, prefix);
  const referenced = new Set(referencedPaths);
  const orphans = allBlobs.filter((name) => !referenced.has(name));
  for (let i = 0; i < orphans.length; i++) {
    setBlobActionStatus(`Removing orphaned file ${i + 1} / ${orphans.length}\u2026`, 'info');
    await blobStore.deleteBlob(sasUrl, orphans[i]);
  }
  return orphans.length;
}

// ---- Merge helpers (last-write-wins, at sentence granularity) ----
//
// These decide, field by field, whose value survives when the same session
// exists on two devices with independent edits since the last sync. The
// design deliberately tracks THREE separate "changed at" signals rather than
// one, because collapsing them into a single timestamp is exactly what would
// force the granularity back up to the whole session:
//   - each sentence's own `updatedAt` (js/store.js's stampSentenceVersions)
//   - a session's `metaUpdatedAt`, for its own scalar fields (name/folderId/
//     splitMode/inputText), separate from...
//   - a session's general `updatedAt`, bumped on every save (sentence-only
//     edits included) and used only for "recently used" sorting.
// A folder has no sub-structure worth splitting further, so it merges on its
// own single `updatedAt`.

function pickNewer(aTs, bTs) {
  return (bTs || 0) > (aTs || 0) ? 'b' : 'a';
}

/**
 * Per-sentence-id union + LWW merge. Tags each surviving sentence with which
 * side it came from (`__from`, stripped before storage/manifest use) so the
 * sync flow below knows, without re-deriving it, whether it already holds
 * that sentence's winning recording or still needs to fetch/send it.
 *
 * No tombstones: sentences are never added to or removed from a session after
 * Split (js/app.js's handleSplit is the only place the array is rebuilt), so
 * there is no "sentence N was deleted" state this needs to represent. Order
 * follows `local`'s sequence -- both sides descend from the same Split, so
 * they should already agree on it; any id that exists only remotely (e.g.
 * this device has never seen this session before) is appended at the end.
 */
function mergeSentences(local, remote) {
  const remoteById = new Map((remote || []).map((s) => [s.id, s]));
  const seen = new Set();
  const merged = (local || []).map((l) => {
    seen.add(l.id);
    const r = remoteById.get(l.id);
    if (!r) return { ...l, __from: 'local' };
    return pickNewer(l.updatedAt, r.updatedAt) === 'b' ? { ...r, __from: 'remote' } : { ...l, __from: 'local' };
  });
  for (const r of remote || []) {
    if (!seen.has(r.id)) merged.push({ ...r, __from: 'remote' });
  }
  return merged;
}

/**
 * Merge one session. Metadata resolves via `metaUpdatedAt` specifically (not
 * sentence `updatedAt`s, not the general `updatedAt`) so a rename on device A
 * and an unrelated recording on device B, made around the same time, both
 * survive instead of one clobbering the other. `local`/`remote` may each be
 * absent (session known to only one side); `mergeSentences` above handles
 * that directly rather than short-circuiting here, so every sentence still
 * gets tagged with its origin.
 */
function mergeSession(local, remote) {
  const base = local || remote;
  const localMeta = local ? (local.metaUpdatedAt ?? local.updatedAt ?? local.createdAt ?? 0) : -1;
  const remoteMeta = remote ? (remote.metaUpdatedAt ?? remote.updatedAt ?? remote.createdAt ?? 0) : -1;
  const metaFrom = remoteMeta > localMeta ? 'remote' : 'local';
  const metaWinner = metaFrom === 'remote' ? remote : base;
  return {
    id: base.id,
    createdAt: Math.min(local?.createdAt ?? Infinity, remote?.createdAt ?? Infinity),
    updatedAt: Math.max(local?.updatedAt || 0, remote?.updatedAt || 0),
    metaUpdatedAt: Math.max(localMeta < 0 ? 0 : localMeta, remoteMeta < 0 ? 0 : remoteMeta),
    name: metaWinner.name,
    folderId: metaWinner.folderId,
    splitMode: metaWinner.splitMode,
    // inputText itself: only the LOCAL copy ever carries the actual text --
    // a remote manifest entry only has inputTextHash (see the manifest
    // shape in syncWithAzure()). __metaFrom tells the sync loop whether it
    // still needs to fetch/keep the actual text, same idea as `__from` on a
    // sentence for its recording/assessment.
    inputText: metaWinner.inputText ?? null,
    inputTextHash: metaWinner.inputTextHash || null,
    __metaFrom: metaFrom,
    sentences: mergeSentences(local?.sentences, remote?.sentences),
  };
}

/** Folder counterpart: no sub-structure, so a plain LWW on `updatedAt` is enough. */
function mergeFolder(local, remote) {
  if (!local) return { ...remote };
  if (!remote) return { ...local };
  return (remote.updatedAt || 0) > (local.updatedAt || 0) ? { ...remote } : { ...local };
}

/** Union two lists by `id`, merging entries present on both sides via `mergeOne`. */
function mergeById(localList, remoteList, mergeOne) {
  const remoteById = new Map((remoteList || []).map((r) => [r.id, r]));
  const seen = new Set();
  const merged = (localList || []).map((l) => {
    seen.add(l.id);
    return mergeOne(l, remoteById.get(l.id));
  });
  for (const r of remoteList || []) {
    if (!seen.has(r.id)) merged.push(mergeOne(null, r));
  }
  return merged;
}

/**
 * Union two tombstone lists by id ("<kind>:<targetId>", from js/store.js),
 * keeping whichever `deletedAt` is newer -- deletions merge the same way
 * edits do, just with a one-bit payload ("gone").
 */
function mergeTombstones(localList, remoteList) {
  const byId = new Map();
  for (const t of localList || []) byId.set(t.id, t);
  for (const t of remoteList || []) {
    const existing = byId.get(t.id);
    if (!existing || t.deletedAt > existing.deletedAt) byId.set(t.id, t);
  }
  return Array.from(byId.values());
}

/**
 * Whether a merged folder/session should still exist after accounting for
 * tombstones: a delete beats an item's own `updatedAt` unless something
 * touched that item again AFTER the delete (an edit newer than the
 * tombstone "un-deletes" it, same principle as any other LWW field here).
 * This is what makes a deletion actually stick across devices instead of
 * being resurrected by the next pull from whichever side still has it.
 */
function survivesTombstone(kind, item, tombstoneById) {
  const t = tombstoneById.get(`${kind}:${item.id}`);
  if (!t) return true;
  return (item.updatedAt || 0) > t.deletedAt;
}

/**
 * Bidirectional incremental sync: merges local IndexedDB data with whatever's
 * on Azure at sentence granularity (see the merge helpers above), uploads
 * only recordings this device's copy actually won and Azure doesn't already
 * have, downloads only recordings the remote side won that this device
 * doesn't already hold, writes the merged result back locally with a
 * non-destructive upsert (never clobbering a session/folder this device
 * hasn't seen), then uploads the merged manifest and sweeps orphaned
 * recordings using paths computed from that MERGED manifest (so a recording
 * only device B knows about doesn't look orphaned from device A's run).
 *
 * Deleting a session or folder IS tracked (js/store.js records a tombstone
 * on deleteSession()/deleteFolder()) and propagates through sync like any
 * other field: survivesTombstone() above only keeps a deletion beaten when
 * something edited that same item again afterward. Edge case worth knowing:
 * a device that's never directly synced with the device that deleted
 * something only learns about the deletion once it syncs with a THIRD device
 * that already has -- tombstones spread by riding along in the manifest, not
 * by broadcasting, so full convergence can take one extra hop in a
 * multi-device chain.
 */
// ---- Automatic sync scheduling ----
//
// Two triggers feed the same path: a local change (debounced, so a burst of
// edits -- e.g. toggling several sentences' hidden flags in a row -- coalesces
// into one sync instead of one per edit) and a 30s idle heartbeat (so a
// device that made no local changes still notices what other devices did).
// Both funnel into runAutoSync(), which (a) waits out a busy session rather
// than skipping it outright -- see isSessionBusy() -- so a change made while
// recording still eventually syncs once recording stops, and (b) takes a
// Web Locks lock before actually running, so if several tabs of this app are
// open at once, only one of them does the network round-trip and the
// IndexedDB writes at a time; the rest see the lock held and simply skip
// that round (the next trigger picks it up).
const AUTO_SYNC_DEBOUNCE_MS = 3000;
const AUTO_SYNC_HEARTBEAT_MS = 30000;
const AUTO_SYNC_LOCK_NAME = 'tuner-cloud-sync';

let autoSyncDebounceTimer = null;
let autoSyncRunning = false; // this tab only; the Web Locks lock below is what actually coordinates across tabs

/**
 * Run syncWithAzure() under the cross-tab lock -- shared by the manual "Sync
 * now" click and the automatic triggers below, so a manual click can never
 * overlap an automatic run IN THE SAME TAB either (without this, the two
 * paths would call syncWithAzure() independently and could run concurrently,
 * reintroducing exactly the read-then-write races the lock is meant to rule
 * out). `wait: true` means a manual click queues behind an in-progress
 * automatic sync instead of silently skipping -- the user asked for it, so it
 * should happen, just after the one already running finishes.
 */
async function runSyncExclusive({ wait, fn = syncWithAzure }) {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    // No Web Locks support (older browser): same-tab-only guard. Cross-tab
    // races become possible, but this tab still never overlaps itself.
    if (autoSyncRunning) return;
    autoSyncRunning = true;
    try { await fn(); } finally { autoSyncRunning = false; }
    return;
  }
  await navigator.locks.request(AUTO_SYNC_LOCK_NAME, wait ? {} : { ifAvailable: true }, async (lock) => {
    if (!lock) return; // another tab is already syncing -- this round is skipped, not queued
    autoSyncRunning = true;
    try { await fn(); } finally { autoSyncRunning = false; }
  });
}

/** The manual "Sync now" button: always runs, queuing behind any sync already in progress. */
function runSyncNow() {
  return runSyncExclusive({ wait: true });
}

/** Debounce a local change into an automatic sync a few seconds from now. No-op if cloud sync isn't configured. */
export function scheduleAutoSync(delayMs = AUTO_SYNC_DEBOUNCE_MS) {
  if (!hasBlobSasUrl()) return;
  clearTimeout(autoSyncDebounceTimer);
  autoSyncDebounceTimer = setTimeout(runAutoSync, delayMs);
}

/**
 * Entry point for both automatic triggers (a debounced local change, and the
 * 30s idle heartbeat). Never shows a blocking alert() or asks for
 * confirmation (those are for the manual "Sync now" click) -- a failure here
 * just leaves the status line saying so and waits for the next trigger.
 */
async function runAutoSync() {
  if (!hasBlobSasUrl()) return;
  if (isSessionBusy()) {
    // Don't drop the change: try again shortly rather than waiting for the
    // next unrelated trigger, which might be a while (e.g. mid-recording a
    // long sentence, or nothing else happens for the rest of the 30s window).
    scheduleAutoSync(AUTO_SYNC_DEBOUNCE_MS);
    return;
  }
  await runSyncExclusive({ wait: false });
}

let autoSyncHeartbeatTimer = null;

/** 30s idle heartbeat: only ticks while the tab is visible, so a backgrounded/pinned tab doesn't keep polling Azure and burning battery/quota. */
function startAutoSyncHeartbeat() {
  if (autoSyncHeartbeatTimer) return;
  autoSyncHeartbeatTimer = setInterval(() => {
    if (document.hidden) return;
    runAutoSync();
  }, AUTO_SYNC_HEARTBEAT_MS);
  document.addEventListener('visibilitychange', () => {
    // Catch up promptly on returning to the tab, instead of waiting out
    // whatever's left of the current 30s tick.
    if (!document.hidden) runAutoSync();
  });
}

async function syncWithAzure() {
  const sasUrl = loadBlobSasUrl();
  if (!sasUrl) { alert('Please save a container SAS URL first.'); return; }

  els.backupNowBtn.disabled = true;
  els.restoreNowBtn.disabled = true;
  try {
    setBlobActionStatus('Reading local data…', 'info');
    const { folders: localFolders, sessions: localSessions, tombstones: localTombstones } = await store.exportAll();

    setBlobActionStatus('Checking remote backup…', 'info');
    let remoteManifest = { folders: [], sessions: [], tombstones: [] };
    try {
      const result = await blobStore.downloadJsonConditional(sasUrl, BLOB_MANIFEST_PATH, manifestEtagCache.etag);
      if (result.notModified) {
        // Azure confirmed nothing changed since our cached copy -- reuse it
        // rather than treating "304, no body" as an empty manifest.
        remoteManifest = manifestEtagCache.manifest;
      } else {
        remoteManifest = result.value;
        manifestEtagCache = { etag: result.etag, manifest: remoteManifest };
      }
    } catch (err) {
      if (!err.notFound) throw err;
      manifestEtagCache = { etag: null, manifest: null };
    }
    const remoteFolders = remoteManifest.folders || [];
    const remoteSessions = remoteManifest.sessions || [];
    const remoteTombstones = remoteManifest.tombstones || [];

    const mergedTombstones = mergeTombstones(localTombstones, remoteTombstones);
    const tombstoneById = new Map(mergedTombstones.map((t) => [t.id, t]));

    // What we already hold, keyed by "sessionId/sentenceId" (or just
    // sessionId for inputText) -- used below to avoid re-downloading content
    // we already have, and to find the actual bytes for something we won
    // and need to upload. Three separate maps, one per content kind, all
    // synced the same way (content-addressed by hash, fetched only when the
    // merge decides this device still needs it).
    const localRecordingById = new Map();
    const localAssessmentById = new Map();
    const localInputTextBySession = new Map();
    for (const session of localSessions) {
      if (session.inputText) {
        localInputTextBySession.set(session.id, { text: session.inputText, hash: session.inputTextHash || null });
      }
      for (const s of session.sentences || []) {
        if (s.recordingBlob) {
          localRecordingById.set(`${session.id}/${s.id}`, { blob: s.recordingBlob, hash: s.recordingHash || null });
        }
        if (s.assessment) {
          localAssessmentById.set(`${session.id}/${s.id}`, { json: JSON.stringify(s.assessment), value: s.assessment, hash: s.assessmentHash || null });
        }
      }
    }

    const mergedFolders = mergeById(localFolders, remoteFolders, mergeFolder);
    const mergedSessions = mergeById(localSessions, remoteSessions, mergeSession);

    // Apply deletions: a tombstone beats a folder's/session's own `updatedAt`
    // unless something edited it again after the delete (see
    // survivesTombstone()'s docs). Everything below works from the survivors
    // only -- including recording downloads, so a session that's being
    // deleted never has its recordings fetched just to throw them away.
    const survivingFolders = mergedFolders.filter((f) => survivesTombstone('folder', f, tombstoneById));
    const survivingSessions = mergedSessions.filter((s) => survivesTombstone('session', s, tombstoneById));
    const casualtyFolderIds = new Set(mergedFolders.filter((f) => !survivesTombstone('folder', f, tombstoneById)).map((f) => f.id));
    const casualtySessionIds = new Set(mergedSessions.filter((s) => !survivesTombstone('session', s, tombstoneById)).map((s) => s.id));

    // A session/folder can end up pointing at a folder that just got deleted
    // above (e.g. it was moved into that folder on a device that never heard
    // about the delete) -- fall back to root rather than leave a dangling
    // reference the History tree can't place.
    const survivingFolderIds = new Set(survivingFolders.map((f) => f.id));
    for (const f of survivingFolders) {
      if (f.parentId != null && !survivingFolderIds.has(f.parentId)) f.parentId = null;
    }
    for (const s of survivingSessions) {
      if (s.folderId != null && !survivingFolderIds.has(s.folderId)) s.folderId = null;
    }

    const totalMaybeDownloads = survivingSessions.reduce((sum, s) => {
      const sentenceDownloads = (s.sentences || [])
        .filter((x) => x.__from === 'remote' && (x.recordingHash || x.assessmentHash)).length;
      const inputTextDownload = s.__metaFrom === 'remote' && s.inputTextHash ? 1 : 0;
      return sum + sentenceDownloads + inputTextDownload;
    }, 0);

    let downloadCount = 0;
    const recordingUploads = [];
    const assessmentUploads = [];
    const inputTextUploads = [];
    const finalSessions = [];
    for (const session of survivingSessions) {
      // Session-level content (inputText) -- resolved once per session, not per sentence.
      let inputText = null;
      if (session.inputTextHash) {
        if (session.__metaFrom === 'local') {
          inputText = session.inputText ?? null;
          const remoteSession = remoteSessions.find((rs) => rs.id === session.id);
          const alreadyOnAzure = remoteSession && remoteSession.inputTextHash === session.inputTextHash;
          if (!alreadyOnAzure && inputText != null) {
            inputTextUploads.push({ sessionId: session.id, text: inputText });
          }
        } else {
          const localEntry = localInputTextBySession.get(session.id);
          if (localEntry && localEntry.hash === session.inputTextHash) {
            // Remote won, but we already hold this exact text (likely: ours from an earlier sync).
            inputText = localEntry.text;
          } else {
            downloadCount++;
            setBlobActionStatus(`Downloading practice text ${downloadCount} / ${totalMaybeDownloads}…`, 'info');
            const blob = await blobStore.downloadBytes(sasUrl, blobInputTextPath(session.id));
            inputText = await blob.text();
          }
        }
      }

      const sentencesOut = [];
      for (const sentence of session.sentences || []) {
        const key = `${session.id}/${sentence.id}`;
        const localRecording = localRecordingById.get(key);
        const localAssessmentEntry = localAssessmentById.get(key);
        const remoteSession = remoteSessions.find((rs) => rs.id === session.id);
        const remoteSentence = remoteSession && (remoteSession.sentences || []).find((rs) => rs.id === sentence.id);

        let recordingBlob = null;
        if (sentence.recordingHash) {
          if (sentence.__from === 'local') {
            const alreadyOnAzure = remoteSentence && remoteSentence.recordingHash === sentence.recordingHash;
            recordingBlob = localRecording ? localRecording.blob : null;
            if (!alreadyOnAzure && recordingBlob) {
              recordingUploads.push({ sessionId: session.id, sentenceId: sentence.id, blob: recordingBlob });
            }
          } else if (localRecording && localRecording.hash === sentence.recordingHash) {
            // Remote won, but we already hold that exact take (likely: it's
            // ours from an earlier sync and nothing's changed since).
            recordingBlob = localRecording.blob;
          } else {
            downloadCount++;
            setBlobActionStatus(`Downloading recording ${downloadCount} / ${totalMaybeDownloads}…`, 'info');
            recordingBlob = await blobStore.downloadBytes(sasUrl, blobRecordingPath(session.id, sentence.id));
          }
        }

        let assessment = null;
        if (sentence.assessmentHash) {
          if (sentence.__from === 'local') {
            const alreadyOnAzure = remoteSentence && remoteSentence.assessmentHash === sentence.assessmentHash;
            assessment = localAssessmentEntry ? localAssessmentEntry.value : (sentence.assessment ?? null);
            if (!alreadyOnAzure && localAssessmentEntry) {
              assessmentUploads.push({ sessionId: session.id, sentenceId: sentence.id, json: localAssessmentEntry.json });
            }
          } else if (localAssessmentEntry && localAssessmentEntry.hash === sentence.assessmentHash) {
            assessment = localAssessmentEntry.value;
          } else {
            downloadCount++;
            setBlobActionStatus(`Downloading score ${downloadCount} / ${totalMaybeDownloads}…`, 'info');
            assessment = await blobStore.downloadJson(sasUrl, blobAssessmentPath(session.id, sentence.id));
          }
        }

        const { __from, ...cleanSentence } = sentence;
        sentencesOut.push({ ...cleanSentence, recordingBlob, assessment });
      }
      const { __metaFrom, ...cleanSession } = session;
      finalSessions.push({ ...cleanSession, inputText, sentences: sentencesOut });
    }

    for (let i = 0; i < recordingUploads.length; i++) {
      const { sessionId, sentenceId, blob } = recordingUploads[i];
      setBlobActionStatus(`Uploading recording ${i + 1} / ${recordingUploads.length}…`, 'info');
      await blobStore.uploadBytes(sasUrl, blobRecordingPath(sessionId, sentenceId), blob, 'audio/wav');
    }
    for (let i = 0; i < assessmentUploads.length; i++) {
      const { sessionId, sentenceId, json } = assessmentUploads[i];
      setBlobActionStatus(`Uploading score ${i + 1} / ${assessmentUploads.length}…`, 'info');
      await blobStore.uploadBytes(sasUrl, blobAssessmentPath(sessionId, sentenceId), new TextEncoder().encode(json), 'application/json');
    }
    for (let i = 0; i < inputTextUploads.length; i++) {
      const { sessionId, text } = inputTextUploads[i];
      setBlobActionStatus(`Uploading practice text ${i + 1} / ${inputTextUploads.length}…`, 'info');
      await blobStore.uploadBytes(sasUrl, blobInputTextPath(sessionId), new TextEncoder().encode(text), 'text/plain; charset=utf-8');
    }

    // The manifest itself now only carries hashes for these three content
    // kinds, never the content -- an assessment (word/phoneme scores) used
    // to be by far the largest thing embedded here once anything was
    // scored, and inputText duplicated text already spread across
    // `sentences[].text`. Both now live as their own small blobs (uploaded
    // above), fetched only when a merge actually needs them.
    const manifest = {
      version: 4,
      exportedAt: new Date().toISOString(),
      folders: survivingFolders,
      tombstones: mergedTombstones,
      sessions: finalSessions.map((session) => ({
        id: session.id,
        folderId: session.folderId,
        name: session.name,
        splitMode: session.splitMode,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        metaUpdatedAt: session.metaUpdatedAt,
        hasInputText: !!session.inputTextHash,
        inputTextHash: session.inputTextHash || null,
        sentences: (session.sentences || []).map((s) => ({
          id: s.id,
          text: s.text,
          lang: s.lang,
          hidden: s.hidden,
          hasRecording: !!s.recordingHash,
          recordingHash: s.recordingHash || null,
          hasAssessment: !!s.assessmentHash,
          assessmentHash: s.assessmentHash || null,
          updatedAt: s.updatedAt,
        })),
      })),
    };
    // If the merge produced exactly what's already confirmed live on Azure --
    // the common case for a heartbeat tick where nothing changed on either
    // side -- skip re-uploading a multi-KB blob that would just overwrite
    // itself. Local storage below is still written unconditionally: this
    // only short-circuits the network round-trip. `exportedAt` is excluded
    // from the comparison since it's just an informational "when was this
    // written" stamp that changes on every call regardless of content --
    // comparing it directly would defeat this check every single time.
    const { exportedAt: _manifestExportedAt, ...manifestForCompare } = manifest;
    const { exportedAt: _remoteExportedAt, ...remoteForCompare } = remoteManifest;
    if (JSON.stringify(manifestForCompare) === JSON.stringify(remoteForCompare)) {
      manifestEtagCache = { etag: manifestEtagCache.etag, manifest };
    } else {
      setBlobActionStatus('Uploading manifest…', 'info');
      const newEtag = await blobStore.uploadJson(sasUrl, BLOB_MANIFEST_PATH, manifest);
      manifestEtagCache = { etag: newEtag, manifest };
    }

    // Best-effort orphan cleanup, one pass per content kind, using paths
    // referenced by the MERGED manifest -- not just this device's local
    // sessions -- so content only known to some other device doesn't look
    // orphaned from here.
    let cleanedCount = 0;
    let cleanupWarning = '';
    try {
      const recordingPaths = manifest.sessions.flatMap((session) => (session.sentences || [])
        .filter((s) => s.hasRecording)
        .map((s) => blobRecordingPath(session.id, s.id)));
      const assessmentPaths = manifest.sessions.flatMap((session) => (session.sentences || [])
        .filter((s) => s.hasAssessment)
        .map((s) => blobAssessmentPath(session.id, s.id)));
      const inputTextPaths = manifest.sessions
        .filter((session) => session.hasInputText)
        .map((session) => blobInputTextPath(session.id));
      cleanedCount += await cleanupOrphanBlobs(sasUrl, BLOB_RECORDINGS_PREFIX, recordingPaths);
      cleanedCount += await cleanupOrphanBlobs(sasUrl, BLOB_ASSESSMENTS_PREFIX, assessmentPaths);
      cleanedCount += await cleanupOrphanBlobs(sasUrl, BLOB_INPUTTEXT_PREFIX, inputTextPaths);
    } catch (err) {
      cleanupWarning = ` (orphan cleanup skipped: ${err.message})`;
      console.warn('Orphan file cleanup skipped:', err);
    }

    setBlobActionStatus('Saving merged data locally…', 'info');
    await store.upsertFolders(survivingFolders);
    await store.upsertSessions(finalSessions);
    for (const id of casualtySessionIds) await store.removeSessionRecord(id);
    for (const id of casualtyFolderIds) await store.removeFolderRecord(id);
    await store.upsertTombstones(mergedTombstones);

    // If the session currently on screen was deleted by the merge, clear it
    // off-screen (same as "Restore from Azure" does for a destructive
    // change); if it was merely touched, reload it so the visible
    // sentences/scores reflect the merged result. Either way, any
    // not-yet-saved in-flight UI state (e.g. an open word Retest) is
    // discarded -- same tradeoff "Restore from Azure" already makes.
    if (currentSessionId != null) {
      if (casualtySessionIds.has(currentSessionId)) {
        for (const s of sentences) s.recorder.dispose();
        setSentences([]);
        setCurrentSessionId(null);
        els.input.value = '';
        render();
      } else {
        const refreshed = finalSessions.find((s) => s.id === currentSessionId);
        if (refreshed) applyIncomingSessionUpdate(refreshed);
      }
    }
    refreshHistoryTreeIfOpen();

    setBlobActionStatus(
      `Sync complete — ${finalSessions.length} session(s), ${recordingUploads.length + assessmentUploads.length + inputTextUploads.length} uploaded, ${downloadCount} downloaded` +
      (casualtySessionIds.size || casualtyFolderIds.size
        ? `, ${casualtySessionIds.size} session(s)/${casualtyFolderIds.size} folder(s) deleted`
        : '') +
      (cleanedCount ? `, ${cleanedCount} orphan recording(s) removed` : '') +
      `.${cleanupWarning}`,
      cleanupWarning ? 'error' : 'recording',
    );
  } catch (err) {
    setBlobActionStatus('Sync failed: ' + err.message, 'error');
  } finally {
    els.backupNowBtn.disabled = false;
    els.restoreNowBtn.disabled = false;
  }
}

/** Replace ALL local history with whatever is currently backed up on Azure. */
async function restoreFromAzure() {
  const sasUrl = loadBlobSasUrl();
  if (!sasUrl) { alert('Please save a container SAS URL first.'); return; }
  if (!confirm(
    'This replaces ALL local practice history in this browser with the backup stored on Azure. ' +
    'This cannot be undone. Continue?',
  )) return;

  els.backupNowBtn.disabled = true;
  els.restoreNowBtn.disabled = true;
  try {
    setBlobActionStatus('Downloading manifest\u2026', 'info');
    let manifest;
    try {
      manifest = await blobStore.downloadJson(sasUrl, BLOB_MANIFEST_PATH);
    } catch (err) {
      if (err.notFound) {
        setBlobActionStatus('No backup found on Azure yet \u2014 run "Sync now" first.', 'error');
        return;
      }
      throw err;
    }

    const manifestSessions = manifest.sessions || [];
    // Recordings, assessments and inputText all live as their own blobs now
    // (see syncWithAzure()'s big comment) -- a full restore has to fetch all
    // three kinds, not just recordings.
    const totalDownloads = manifestSessions.reduce((sum, session) => {
      const sentenceDownloads = (session.sentences || [])
        .filter((s) => s.hasRecording || s.hasAssessment).length;
      return sum + sentenceDownloads + (session.hasInputText ? 1 : 0);
    }, 0);

    let downloaded = 0;
    const sessionsOut = [];
    for (const session of manifestSessions) {
      let inputText = '';
      if (session.hasInputText) {
        downloaded++;
        setBlobActionStatus(`Downloading practice text ${downloaded} / ${totalDownloads}\u2026`, 'info');
        const blob = await blobStore.downloadBytes(sasUrl, blobInputTextPath(session.id));
        inputText = await blob.text();
      }

      const sentencesOut = [];
      for (const s of session.sentences || []) {
        let recordingBlob = null;
        if (s.hasRecording) {
          downloaded++;
          setBlobActionStatus(`Downloading recording ${downloaded} / ${totalDownloads}\u2026`, 'info');
          recordingBlob = await blobStore.downloadBytes(sasUrl, blobRecordingPath(session.id, s.id));
        }
        let assessment = null;
        if (s.hasAssessment) {
          downloaded++;
          setBlobActionStatus(`Downloading score ${downloaded} / ${totalDownloads}\u2026`, 'info');
          assessment = await blobStore.downloadJson(sasUrl, blobAssessmentPath(session.id, s.id));
        }
        sentencesOut.push({
          id: s.id,
          text: s.text,
          lang: s.lang,
          hidden: s.hidden,
          assessment,
          recordingBlob,
          recordingHash: s.recordingHash || null,
          assessmentHash: s.assessmentHash || null,
          updatedAt: s.updatedAt || session.updatedAt || session.createdAt || 0,
        });
      }
      sessionsOut.push({
        id: session.id,
        folderId: session.folderId,
        name: session.name,
        inputText,
        inputTextHash: session.inputTextHash || null,
        splitMode: session.splitMode,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        metaUpdatedAt: session.metaUpdatedAt || session.updatedAt || session.createdAt || 0,
        sentences: sentencesOut,
      });
    }

    setBlobActionStatus('Writing to local storage\u2026', 'info');
    await store.restoreSnapshot({ folders: manifest.folders || [], sessions: sessionsOut, tombstones: manifest.tombstones || [] });

    // The restored data lives in IndexedDB now; clear the live screen state
    // (any recordings held only in memory are gone) and let the user pick a
    // session from the (now refreshed) history tree.
    for (const s of sentences) s.recorder.dispose();
    setSentences([]);
    setCurrentSessionId(null);
    els.input.value = '';
    render();
    refreshHistoryTreeIfOpen();

    setBlobActionStatus(
      `Restore complete \u2014 ${sessionsOut.length} session(s), ${totalDownloads} file(s) downloaded.`,
      'recording',
    );
  } catch (err) {
    setBlobActionStatus('Restore failed: ' + err.message, 'error');
  } finally {
    els.backupNowBtn.disabled = false;
    els.restoreNowBtn.disabled = false;
  }
}

export function initBlobPanel() {
  els.saveBlobBtn.addEventListener('click', () => {
    const url = els.blobSasInput.value.trim();
    if (!url) {
      alert('Please paste a container SAS URL');
      return;
    }
    saveBlobSasUrl(url);
    els.blobSasInput.value = '';
    updateBlobPanel();
    scheduleAutoSync(0); // pick up whatever's already on Azure right away, rather than waiting for the first edit or heartbeat tick
  });

  els.clearBlobBtn.addEventListener('click', () => {
    clearBlobSasUrl();
    els.blobSasInput.value = '';
    updateBlobPanel();
  });

  els.backupNowBtn.addEventListener('click', runSyncNow);
  els.restoreNowBtn.addEventListener('click', () => runSyncExclusive({ wait: true, fn: restoreFromAzure }));

  updateBlobPanel();
  startAutoSyncHeartbeat();
}
