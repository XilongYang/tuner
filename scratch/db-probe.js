// Paste into the DevTools console on the Tuner page. Reads only.
(async () => {
  const open = (name) => new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
  const all = (db, store) => new Promise((res) => { try { const r = db.transaction([store], 'readonly').objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); } catch { res([]); } });
  const out = [];
  // Only databases that already exist: indexedDB.open() on an unknown name
  // would create it, and this must not write anything.
  const listed = await indexedDB.databases();
  out.push(`databases: ${JSON.stringify(listed)}`);
  const est = await navigator.storage.estimate();
  out.push(`storage: ${(est.usage / 1e6).toFixed(1)} MB of ${(est.quota / 1e6).toFixed(0)} MB, persisted: ${await navigator.storage.persisted()}`);
  for (const { name } of listed) {
    const db = await open(name);
    if (!db) { out.push(`${name}: could not be opened`); continue; }
    out.push(`${name} v${db.version} stores: ${[...db.objectStoreNames].join(', ')}`);
    for (const store of db.objectStoreNames) {
      const rows = await all(db, store);
      out.push(`  ${store}: ${rows.length} records`);
      if (store === 'sessions' || store === 'tuner-sessions' || store === 'sessions-v2') {
        for (const s of rows) {
          const sentences = s.sentences || [];
          const blobs = sentences.flatMap((x) => Object.keys(x).filter((k) => x[k] && typeof x[k].arrayBuffer === 'function'));
          const hashes = sentences.flatMap((x) => Object.keys(x).filter((k) => /Hash$/.test(k) && x[k]));
          out.push(`    ${s.id} | "${(s.name || '').slice(0, 20)}" | ${sentences.length} sentences | blobFields=${JSON.stringify([...new Set(blobs)])} | hashFields=${JSON.stringify([...new Set(hashes)])} | sourceAudio=${s.sourceAudio || s.sourceAudioBlob ? 'yes' : 'no'} | updated ${s.updatedAt ? new Date(s.updatedAt).toISOString().slice(0, 16) : '-'}`);
        }
      }
    }
    db.close();
  }
  const text = out.join('\n');
  console.log(text);
  try { copy(text); console.log('(copied)'); } catch {}
  return text;
})();
