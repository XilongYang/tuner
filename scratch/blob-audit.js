// Paste into the DevTools console on the Tuner page, in the browser where the
// sync warning appeared. Reads only; writes nothing, deletes nothing.
//
// It opens the app's database directly, tries to read every stored audio Blob,
// and reports which ones are readable and whether their bytes still match the
// hash the record claims. What the pattern looks like is the diagnosis:
//
//   every blob dead, of every kind           -> the origin's storage was evicted
//   only `reference` dead, `recording` fine  -> only the externally-backed
//                                               Blobs were lost (a TTS clip is
//                                               a fetch response body; a
//                                               recording is built in memory)
//   readable but the hash does not match     -> the bytes were truncated
//   only the oldest sessions dead            -> age-based eviction
(async () => {
  const sha256 = async (buffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)))
    .map((b) => b.toString(16).padStart(2, '0')).join('');

  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('tuner');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const all = (store) => new Promise((resolve, reject) => {
    const req = db.transaction([store], 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const slots = [];
  for (const session of await all('sessions')) {
    slots.push({
      path: `inputtext/${session.id}.txt`, kind: 'inputText', session: session.id,
      updatedAt: session.updatedAt, value: session.inputText, hash: session.inputTextHash,
    });
    slots.push({
      path: `sourceaudio/${session.id}.audio`, kind: 'sourceAudio', session: session.id,
      updatedAt: session.updatedAt, value: session.sourceAudio, hash: session.sourceAudioHash,
    });
    for (const s of session.sentences || []) {
      slots.push({
        path: `recordings/${session.id}/${s.id}.wav`, kind: 'recording', session: session.id,
        updatedAt: s.updatedAt, value: s.recording, hash: s.recordingHash,
      });
      slots.push({
        path: `references/${session.id}/${s.id}.audio`, kind: `reference(${s.referenceSource || 'none'})`,
        session: session.id, updatedAt: s.updatedAt, value: s.reference, hash: s.referenceHash,
      });
    }
  }
  for (const entry of await all('vocab')) {
    for (const o of entry.sources || []) {
      slots.push({
        path: `vocab-audio/${entry.audioPathKey}/${o.occurrenceId}.audio`, kind: 'vocabAudio',
        session: o.sessionId, updatedAt: entry.updatedAt, value: o.audio, hash: o.audioHash,
      });
    }
  }

  const rows = [];
  for (const slot of slots) {
    if (slot.hash == null && slot.value == null) continue;
    const row = {
      path: slot.path,
      kind: slot.kind,
      claimed: slot.hash ? `${slot.hash.slice(0, 8)}…` : null,
      bytes: null,
      state: null,
      updated: slot.updatedAt ? new Date(slot.updatedAt).toISOString().slice(0, 16) : null,
      detail: '',
    };
    if (slot.value == null) row.state = slot.hash ? 'claimed, not held' : 'empty';
    else if (typeof slot.value === 'string') {
      row.bytes = slot.value.length;
      row.state = 'text';
    } else if (typeof slot.value.arrayBuffer !== 'function') {
      row.state = 'not a Blob';
      row.detail = typeof slot.value;
    } else {
      row.bytes = slot.value.size;
      try {
        const buffer = await slot.value.arrayBuffer();
        const actual = await sha256(buffer);
        if (buffer.byteLength !== slot.value.size) {
          row.state = 'short read';
          row.detail = `${buffer.byteLength} of ${slot.value.size}`;
        } else if (slot.hash && actual !== slot.hash) {
          row.state = 'hash mismatch';
          row.detail = `${actual.slice(0, 8)}…`;
        } else row.state = 'ok';
      } catch (err) {
        row.state = 'UNREADABLE';
        row.detail = `${err.name}: ${err.message}`;
      }
    }
    rows.push(row);
  }

  const tally = (of) => of.reduce((acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] || 0) + 1 }), {});
  const states = [...new Set(rows.map((r) => r.state))];

  // One string, so the whole answer can be copied out in one go: console.table
  // below is for reading, this is for reporting.
  const report = [
    `tuner blob audit — ${rows.length} content slots`,
    ...states.map((state) => `  ${state}: ${rows.filter((r) => r.state === state).length} ${JSON.stringify(tally(rows.filter((r) => r.state === state)))}`),
    '',
    'not ok:',
    ...rows.filter((r) => r.state !== 'ok' && r.state !== 'text')
      .map((r) => `  ${r.state} | ${r.kind} | ${r.bytes ?? '-'} bytes | updated ${r.updated ?? '-'} | ${r.path}${r.detail ? ` | ${r.detail}` : ''}`),
    '',
    navigator.userAgent,
  ];
  try {
    const estimate = await navigator.storage.estimate();
    report.push(`storage: ${(estimate.usage / 1e6).toFixed(1)} MB used of ${(estimate.quota / 1e6).toFixed(0)} MB, persisted: ${await navigator.storage.persisted?.()}`);
  } catch (err) { report.push(`storage estimate unavailable: ${err.message}`); }

  console.table(rows);
  const text = report.join('\n');
  console.log(text);
  try { copy(text); console.log('(copied to the clipboard)'); } catch { /* no console helper here */ }
  return text;
})();
