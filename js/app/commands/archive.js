// Moving everything out of the app as one file, and back in.
//
// An archive is a sync container held in a file: the same manifest, the same
// content paths, the same hashes. That is deliberate and it is what keeps this
// small -- exporting is planning a round against an empty container, and
// importing is planning one against the archive, so what an import does with
// a record that exists on both sides (the newer one wins, a deletion beats an
// older edit, vocab occurrences union) is the sync's own answer, already
// tested, and not a second set of rules that could disagree with it.
//
// An import never replaces what is here. It merges, which means importing the
// same file twice changes nothing the second time, and importing an old backup
// cannot take away what was recorded since.

import { planSync } from '../../cloud/sync/plan.js';
import { MANIFEST_PATH, transferContent, encode } from '../../cloud/sync/run.js';
import { contentKind, contentPath } from '../../model/content.js';
import { SESSION, VOCAB_ENTRY, dropContent } from '../../model/schema.js';
import { readZip, writeZip } from '../../platform/zip.js';

export const ARCHIVE_MIME = 'application/zip';

const CLOCKS = { sessions: 'updatedAt', vocab: 'updatedAt' };

/**
 * Everything on this device, as one archive.
 *
 * Content whose bytes are not here is left out of the file and out of the
 * manifest's claims -- the same rule a sync round follows -- and counted, so
 * the person is told rather than handed a backup that claims more than it has.
 *
 * @returns {Promise<{blob: Blob, sessions: number, vocab: number, files: number, missing: string[]}>}
 */
export async function exportArchive({ db, hash }) {
  const snapshot = await db.snapshot();
  let plan = planSync({ local: snapshot, remote: null });

  const entries = [];
  const missing = new Set();
  for (const slot of plan.slots) {
    const entry = await db.readContent(slot.hash);
    let value = entry?.value ?? null;
    if (value != null && typeof value.arrayBuffer === 'function') {
      try { value = await hash.materializeBlob(value); } catch { value = null; }
    }
    if (value == null) { missing.add(slot.path); continue; }
    entries.push({ name: slot.path, data: encode(slot.kind, value) });
  }

  if (missing.size) {
    const without = { ...snapshot };
    for (const [key, def] of [['sessions', SESSION], ['vocab', VOCAB_ENTRY]]) {
      without[key] = snapshot[key].map((record) => dropContent(def, record, (slot) => missing.has(contentPath(slot.kind, slot.ref))));
    }
    plan = planSync({ local: without, remote: null });
  }

  entries.unshift({ name: MANIFEST_PATH, data: new TextEncoder().encode(JSON.stringify(plan.manifest)) });
  return {
    blob: await writeZip(entries, ARCHIVE_MIME),
    sessions: plan.manifest.sessions.length,
    vocab: plan.manifest.vocab.length,
    files: entries.length - 1,
    missing: [...missing],
  };
}

const fail = (reason) => ({ ok: false, reason, added: 0, written: 0, skipped: 0, deleted: 0, warnings: [] });

/**
 * Merge an archive into what is here.
 *
 * Reads and checks the whole file before writing anything: a file that is not
 * an archive, or is cut short, changes nothing.
 *
 * @returns {Promise<{ok: boolean, reason: string|null, added: number, written: number, skipped: number, deleted: number, warnings: string[]}>}
 */
export async function importArchive({ db, hash, file }) {
  let entries;
  let manifest;
  try {
    entries = await readZip(file);
    const bytes = entries.get(MANIFEST_PATH);
    if (!bytes) return fail('This file is not a Tuner archive (it has no manifest).');
    manifest = JSON.parse(await bytes.text());
  } catch (err) {
    return fail(`This file could not be read: ${err.message}`);
  }
  if (!manifest || !Array.isArray(manifest.sessions) || !Array.isArray(manifest.vocab)) {
    return fail('This file is not a Tuner archive (its manifest is not one).');
  }

  let plan;
  try {
    plan = planSync({ local: await db.snapshot(), remote: manifest });
  } catch (err) {
    return fail(err.message);
  }

  const archive = {
    downloadBytes: async (path) => {
      const blob = entries.get(path);
      if (!blob) throw Object.assign(new Error(`"${path}" is not in the archive`), { notFound: true });
      return blob;
    },
  };
  const wanted = { ...plan, slots: plan.slots.filter((slot) => slot.action === 'download'), unresolved: [] };
  const transfer = await transferContent(wanted, archive, { getValue: async () => null });

  // Bytes sliced from the chosen file are a reference to it, and the file can
  // go away; what is stored is a copy of its own (see platform/hash.js).
  const content = [];
  for (const slot of wanted.slots) {
    if (!transfer.downloaded.has(slot.path)) continue;
    let value = transfer.downloaded.get(slot.path);
    if (contentKind(slot.kind).encoding === 'bytes') value = await hash.materializeBlob(value);
    content.push({ kind: slot.kind, hash: slot.hash, ownerId: slot.ownerId, value });
  }

  const applied = await db.applyPlan(plan, CLOCKS, { content });
  // `written` is every record the merge stored, including the ones that came
  // out the same as they went in; what a person wants to know is what is new.
  const stored = new Set(applied.written);
  const added = plan.localWrites.filter((w) => w.baseClock === null && stored.has(w.id)).length;
  return {
    ok: true,
    reason: null,
    added,
    written: applied.written.length,
    skipped: applied.skipped.length,
    deleted: applied.deleted.length,
    warnings: transfer.missing.filter((m) => m.direction === 'down').map((m) => `${m.path}: ${m.reason}`),
  };
}
