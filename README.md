# Tuner

A **fully static, backend-free, open and auditable** web tool for read-aloud / shadowing practice and pronunciation scoring in Japanese and English.

- No framework, no npm packages, no CDN dependencies at runtime — just plain HTML / CSS / JavaScript (ES modules). `package.json` exists only for the optional dev-time test suites (see [Testing](#testing) below); nothing it installs is ever loaded by the app itself.
- Deployable directly to GitHub Pages / Cloudflare Pages
- All Azure requests go **straight from your browser to Azure** — no relay backend

## Features

1. Paste text → click **Split** → it is broken into numbered sentences by sentence boundaries (`。！？` / `.!?`)
2. Each sentence's language is auto-detected (ja / en) and can be switched manually
3. **Speak**: play reference audio via Azure Neural TTS (falls back to the browser's built-in voice when no key is set)
4. **Record**: capture your shadowing as 16 kHz WAV via the Web Audio API; **Playback** to listen
5. **Score**: call Azure Pronunciation Assessment (REST) directly for Overall / Accuracy / Fluency / Completeness scores, with each word colored by accuracy, omissions / insertions flagged, and per-phoneme scores on hover
6. **History**: every Split is auto-saved to your browser's local storage (IndexedDB), including recordings and scores. Browse, rename, and organize past sessions into nested folders (via menu or drag-and-drop) from the **History** sidebar
7. **Import audio**: upload an audio file with no reference text instead of pasting text — Tuner transcribes it via Azure Fast Transcription, re-segments the transcript into sentences by punctuation, and slices the original audio so each sentence gets its own exact reference clip
8. **Export / Import history**: the **Export**/**Import** buttons in the History sidebar pack your entire local history (folders, sessions, recordings, scores) into a single downloadable `.tuner` file (a plain ZIP) and read one back in — a manual backup/transfer path independent of Cloud sync
9. **Cloud sync** (optional): sync your local history — including recordings — with your own Azure Blob Storage container, incrementally and in both directions, so it stays consistent across browsers/devices. See [Cloud backup](#cloud-backup-optional) below

## Usage

1. Create a **Speech Service** resource in the [Azure Portal](https://portal.azure.com/) and get its **Key** and **Region** (e.g. `eastasia`, `japaneast`).
2. Open the page, click **Azure settings** in the top-right, enter the Key and Region, and save.
3. Paste text → Split → Speak / Record / Score per sentence.

> You can use it without a key: **Speak** automatically falls back to the browser's built-in voice (`speechSynthesis`), at lower quality.

## About your key (please read)

- The key is **stored only in the browser's localStorage** and is never uploaded to any server.
- This tool has no backend; requests go straight from the browser to Azure, so **your key is visible in the Network panel of the browser dev tools** — this is expected. It is your own key, and you are responsible for its usage and billing.
- A **Clear key** button lets you remove it from local storage at any time.

## Cloud backup (optional)

Practice history lives only in the current browser's IndexedDB by default — clearing site data, switching browsers, or switching devices loses it. If you want a copy that survives that, or that you want kept consistent across devices, you can sync it with your own **Azure Blob Storage** container. Once you've saved a container SAS URL, sync runs **automatically** in the background (once right after the page loads, and again a few seconds after any local change settles) — you can also click **Sync now** any time to force one immediately. It works with **zero backend**: your browser talks to Azure directly using a credential you paste in and that stays only in localStorage.

**1. Create a container and a SAS URL**

1. In the [Azure Portal](https://portal.azure.com/), create (or reuse) a **Storage account**, then a **Blob container** inside it (Private access level is fine).
2. Enable CORS for the storage account so your browser is allowed to call it: **Storage account → Settings → Resource sharing (CORS)** → *Blob service* tab → add a rule with:
   - Allowed origins: the origin you serve Tuner from (e.g. `http://localhost:8000`, or your GitHub/Cloudflare Pages URL) — must match exactly (scheme + host + port, no trailing slash)
   - Allowed methods: `GET`, `PUT`, `DELETE`, `OPTIONS`
   - Allowed headers: `*` (Tuner sends `Content-Type`, `x-ms-blob-type`, `x-ms-version` — an empty Allowed headers column will fail every request with a 403 on preflight)
   - Exposed headers: `*`
   - Max age: `3600` (or any value)
   - Don't forget to click **Save** at the top of the page — filling the row alone doesn't persist it.
3. Generate a **SAS URL scoped to the container**: open the container → **Shared access tokens** (or **Generate SAS** at the container level) → grant **Read**, **Write**, **Create**, **List**, and **Delete** permissions (List + Delete let Sync clean up recordings for sessions you've since deleted locally; without them, sync/restore still work, just without that cleanup), pick an expiry far enough in the future, and copy the resulting URL (it looks like `https://<account>.blob.core.windows.net/<container>?sv=...&sig=...`).

**2. Connect it in Tuner**

1. Click **Cloud backup** in the top-right, paste the container SAS URL, and **Save**. It's stored only in this browser's localStorage, same as the Speech key.
2. From here it runs on its own: once right after the page loads (so this device catches up on what other devices did while it wasn't open), and again a few seconds after you record, score, rename, move, or delete something (debounced, so a burst of edits becomes one sync, not one per edit). Each run merges your local history with whatever's already on Azure **incrementally, per sentence** (see below) and uploads/downloads only what changed. Click **Sync now** to force a run immediately instead of waiting.
3. **Restore from Azure** is a separate, destructive escape hatch: it downloads the Azure copy and **replaces all local history in this browser** with it (you'll be asked to confirm). Use this to recover a browser that lost its local data, or to force one device to match Azure exactly — Sync now is what you want for normal day-to-day use across multiple devices.

**How sync merges changes**

Every sentence carries its own last-changed timestamp (bumped only when that sentence's own text, hidden flag, recording, or score actually changes), separately from a session's name/folder/split-mode timestamp, separately again from the session's general "last touched" timestamp used for sorting. A sync compares these at the sentence level and keeps whichever side is newer, sentence by sentence — so editing sentence 3 on your phone and re-recording sentence 1 on your laptop, before either syncs, merges both changes instead of one wiping out the other.

The manifest itself only stores small metadata (ids, timestamps, flags) plus a content hash for each of three kinds of larger data: a sentence's **recording**, a sentence's **pronunciation assessment** (word/phoneme scores), and a session's **input text**. Each of those is uploaded/downloaded as its own separate blob, addressed by the SHA-256 hash of its content — so if two devices end up with byte-identical content (e.g. neither has re-recorded or re-scored something), it's recognized as already in sync and never re-uploaded or re-downloaded; only content that actually changed moves over the wire. This also means storage for recordings, assessments, and input text is de-duplicated: identical content is only ever stored once, and the manifest itself stays small even as history grows.

**Notes / limitations**

- **Deleting a session or folder is tracked and propagates through sync** (not just a local wipe) — deleting something and syncing removes it from Azure and from every other device the next time each of them syncs. If you edit that same session/folder again after deleting it (on any device, before that delete has reached it), the edit wins and un-deletes it — same last-write-wins rule as everything else here.
- One real edge case: a deletion propagates by riding along in the manifest each device uploads/downloads, not by broadcasting to every device directly. If device A deletes something and device C never syncs directly with A, C only learns about the deletion once it syncs with some device B that already picked it up from A — in a chain of devices that rarely all sync with each other, full convergence can take one extra hop.
- Sync removes recordings, assessments, and input-text blobs on Azure that no session in the *merged* result references any more (including sessions just deleted by the merge above) — this needs the SAS token's **List** and **Delete** permissions in addition to Read/Write/Create; without them, sync still succeeds, it just leaves those orphaned files in place and says so in the status line.
- Anyone with the SAS URL can read/write (and, with List+Delete granted, remove) your container until it expires, so treat it like a password (it's stored unencrypted in localStorage, same caveat as the Speech key above).
- A **Clear SAS URL** button removes it from local storage at any time; it does not delete anything already on Azure.
- Sessions and recordings are keyed by a UUID (not a small counter), so their Azure blob path stays unique and stable even across browsers/devices. Any session saved before this was the case gets migrated to a UUID automatically, once, the next time you load the page — you'll see `Migrated N legacy session(s) to UUID ids.` in the browser console when that happens. The next sync after that re-uploads those recordings under their new path and cleans up the old one (needs List+Delete, per above).
- Similarly, a session saved before per-field content hashing existed has no `inputTextHash` yet; without a one-time backfill, its first sync under this scheme would misread "no hash" as "nothing to resolve" and wipe its input text back to empty. That backfill also runs automatically, once, the next time you load the page — you'll see `Backfilled inputTextHash for N legacy session(s).` in the browser console when it does anything.
- Automatic sync waits out anything actively in progress — a recording, a pronunciation score, a word Retest — rather than running mid-action or overwriting that row's live state; it catches up right after. If you have this page open in several tabs at once, only one tab actually talks to Azure at a time — the rest sit out that round.
- Every sync round, even one that finds nothing changed, checks Azure via a conditional GET (`If-None-Match` against the manifest's cached ETag): when nothing has changed anywhere, Azure answers with a bodyless 304 instead of resending the whole manifest, and the merge step likewise skips re-uploading the manifest when the result is byte-identical to what's already there — so a no-op round costs one small request, not a full read+write of your entire history. This needs the storage account's CORS rule to have **Exposed headers: `*`** (see setup step 1 above) so the browser can actually read the ETag back; without it, sync still works correctly, it just falls back to a full download every time, silently losing the optimization rather than erroring.
- Cleaning up recordings/assessments/input-text blobs for content no longer referenced anywhere re-checks Azure's manifest one more time, right before deleting anything, rather than trusting only the snapshot this device already merged — this closes (though, without cross-device locking, can't fully eliminate) a race where another device's just-uploaded content could otherwise look orphaned here and get deleted moments after that device's own sync reported success.

## Running locally

Because it uses ES modules, serve it over HTTP (not via `file://`):

```bash
# either one
python3 -m http.server 8000
npx serve
```

Then open `http://localhost:8000`.

## Deploying

The app is just `index.html` + `css/` + `js/` — any static host works (GitHub Pages, Cloudflare Pages/Workers, etc.), no build step. The repo also carries a `package.json` for the dev-only test suites (see [Testing](#testing)); if your host runs `npm install` as part of its build (Cloudflare's does, whenever it finds a `package.json`), the resulting `node_modules/` must not end up in what actually gets deployed — a Cloudflare Workers static-assets deploy in particular uploads whatever directory it's told to serve as-is, `node_modules/` included, and that will fail outright once `node_modules` exceeds the platform's per-file size limit (currently 25 MiB; `wrangler`'s own `workerd` binary alone is well over that). The `.assetsignore` file at the repo root (same syntax as `.gitignore`) tells Cloudflare's asset uploader to skip `node_modules/`, `tests/`, `tests-e2e/`, and `.github/` — none of which belong in the deployed site anyway.

## Project layout

```
index.html                  page structure
css/                         design system (one stylesheet per domain, mirroring js/)

js/segment.js                sentence splitting (TERMINATORS regex + segment())
js/lang.js                   language detection (ja / en)
js/config.js                 Azure credential + Blob SAS URL storage (localStorage)
js/state.js                  shared app state (`els`, `sentences`, current session/split-mode, persistSession())
js/app.js                    composition root: wires every domain's init() together
js/tts.js                    TTS (Azure REST + browser fallback)
js/tts-player.js             TTS playback + per-word highlighting during Speak
js/pron.js                   pronunciation assessment (Azure REST)
js/stt.js                    Fast Transcription (Azure REST) for audio import
js/recorder.js                recording (Web Audio → 16 kHz WAV) + WAV encode/decode
js/recorder-worklet.js       AudioWorklet capture processor
js/azure-blob.js             Azure Blob Storage REST client (used by sync/)
js/zip.js                    minimal dependency-free ZIP writer/reader (used by store/backup.js)

js/sentence-panel/           the sentence list: rows, click-to-split, audio import
  row.js                       per-row DOM + button wiring (Speak/Record/Playback/Score/Export)
  split-render.js              list rendering, row selection/Merge UI, split-pointer triangles
  split-geometry.js            pure split-point/geometry math (no DOM/store/network)
  split-actions.js             the only file here that touches store/network: Split/Merge/Import
  audio-decode.js               audio decode/slice + Fast-Transcription re-segmentation by punctuation
  assessment.js, export-utils.js, index.js

js/history-panel/            the History sidebar: folder/session tree
  tree.js                       tree rendering + drag-and-drop filing
  actions.js                    the only file here that touches store: create/rename/move/delete
  panel.js, context-menu.js, move-picker.js, session-open.js, index.js

js/sync/                     Azure cloud backup/sync
  azure-sync.js                 incremental bidirectional sync (the bulk of the logic)
  restore.js                    "Restore from Azure" (full one-way replace)
  merge.js                      pure last-write-wins merge helpers (no DOM/store/network)
  blob-paths.js                 blob path builders + orphan-blob cleanup
  ui-hooks.js                   shared UI-callback registry (avoids a sync -> UI reverse dependency)
  scheduler.js, panel.js, index.js

js/store/                    local persistence (IndexedDB: sessions, folders, tombstones)
  db.js                         open/upgrade the database, object-store names, promise wrappers
  sessions.js, folders.js, tombstones.js    CRUD per object store
  hashing.js                     content hashing (SHA-256) + per-sentence version stamping
  snapshot.js                    full export/restore (used by backup.js and Restore from Azure)
  backup.js                      .tuner backup ZIP build/parse (via ../zip.js)
  index.js                       public API barrel -- other code imports `store/index.js`, never a submodule directly
```

## Browser requirements

- A modern browser (Chrome / Edge / Safari)
- Recording needs microphone permission; `getUserMedia` generally requires HTTPS or `localhost`

## Testing

Two independent, optional test suites live alongside the app. Neither is required to run or deploy Tuner itself — they exist for anyone changing the code. Both need [Node.js](https://nodejs.org/) installed (LTS) purely as a dev tool; the app itself never requires it.

```bash
npm install                    # once, installs devDependencies (fake-indexeddb, playwright)
```

### Unit tests (`tests/`)

```bash
npm test
```

Runs on Node's built-in test runner (`node:test`) — zero extra config. Covers the app's pure/dependency-free logic directly (sentence splitting, language detection, ZIP read/write, sync's merge logic, content hashing, WAV encode/decode, audio re-segmentation math) plus the IndexedDB-backed `store/` layer, exercised against [`fake-indexeddb`](https://github.com/dumbmatter/fakeIndexedDB) (a genuine pure-JS IndexedDB implementation, not a mock) so real transactions/indexes/auto-increment keys are covered without a browser.

Not covered here, by design: anything needing a real browser audio codec or a real microphone —

- `sentence-panel/audio-decode.js`'s `decodeSourceAudio()` calls the browser's `AudioContext.decodeAudioData()` to decode an arbitrary imported audio file (mp3/wav/ogg). The actual decoding logic lives in the browser's native codec, not in this app's code, so there's nothing meaningful to unit-test without a real (or native/WASM) audio decoder dependency.
- `recorder.js`'s `Recorder.start()` / `_startWithWorklet()` / `_startWithScriptProcessor()` need `navigator.mediaDevices.getUserMedia` (a real microphone) and `AudioWorkletNode`. Mocking those would only verify that the code calls the mocked APIs in order, not that real capture works.

Both stay covered by the Playwright suite below instead, which runs in a real browser.

### End-to-end tests (`tests-e2e/`)

```bash
npx playwright install chromium   # once, downloads Playwright's bundled Chromium
npm run test:e2e                  # runs every tests-e2e/test_*.mjs against a real headless Chromium
```

`tests-e2e/server.mjs` serves the app on `http://127.0.0.1:8934` (a zero-dependency static file server using Node's built-in `http`); `tests-e2e/run-all.mjs` starts it, runs every `test_*.mjs` script in the folder, and reports which ones exited cleanly. Pass a substring to run a subset: `npm run test:e2e -- test_split`.

These are **not** assertion-based tests — each script drives the real UI (or calls into a module directly via `page.evaluate()`) and prints what it observed; a script only "fails" here in the sense of throwing or timing out (e.g. a selector never appearing), not a pass/fail check. Reading a script's printed JSON is how you confirm the behavior it exercises is still correct.

## License

MIT
