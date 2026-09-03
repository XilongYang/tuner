# Tuner

A **fully static, backend-free, open and auditable** web tool for read-aloud / shadowing practice and pronunciation scoring in Japanese and English.

- No framework, no npm packages, no CDN dependencies — just plain HTML / CSS / JavaScript (ES modules)
- Deployable directly to GitHub Pages / Cloudflare Pages
- All Azure requests go **straight from your browser to Azure** — no relay backend

## Features

1. Paste text → click **Split** → it is broken into numbered sentences by sentence boundaries (`。！？` / `.!?`)
2. Each sentence's language is auto-detected (ja / en) and can be switched manually
3. **Speak**: play reference audio via Azure Neural TTS (falls back to the browser's built-in voice when no key is set)
4. **Record**: capture your shadowing as 16 kHz WAV via the Web Audio API; **Playback** to listen
5. **Score**: call Azure Pronunciation Assessment (REST) directly for Overall / Accuracy / Fluency / Completeness scores, with each word colored by accuracy, omissions / insertions flagged, and per-phoneme scores on hover
6. **History**: every Split is auto-saved to your browser's local storage (IndexedDB), including recordings and scores. Browse, rename, and organize past sessions into nested folders (via menu or drag-and-drop) from the **History** sidebar
7. **Cloud backup** (optional): back up your entire local history — including recordings — to your own Azure Blob Storage container, and restore it on another browser/device. See [Cloud backup](#cloud-backup-optional) below

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

Practice history lives only in the current browser's IndexedDB by default — clearing site data, switching browsers, or switching devices loses it. If you want a copy that survives that, or that you can carry to another device, you can back it up to your own **Azure Blob Storage** container. This is a **manual, on-demand** backup (there is no automatic background sync) and, like the Speech key above, it works with **zero backend**: your browser talks to Azure directly using a credential you paste in and that stays only in localStorage.

**1. Create a container and a SAS URL**

1. In the [Azure Portal](https://portal.azure.com/), create (or reuse) a **Storage account**, then a **Blob container** inside it (Private access level is fine).
2. Enable CORS for the storage account so your browser is allowed to call it: **Storage account → Settings → Resource sharing (CORS)** → *Blob service* tab → add a rule with:
   - Allowed origins: the origin you serve Tuner from (e.g. `http://localhost:8000`, or your GitHub/Cloudflare Pages URL) — must match exactly (scheme + host + port, no trailing slash)
   - Allowed methods: `GET`, `PUT`, `DELETE`, `OPTIONS`
   - Allowed headers: `*` (Tuner sends `Content-Type`, `x-ms-blob-type`, `x-ms-version` — an empty Allowed headers column will fail every request with a 403 on preflight)
   - Exposed headers: `*`
   - Max age: `3600` (or any value)
   - Don't forget to click **Save** at the top of the page — filling the row alone doesn't persist it.
3. Generate a **SAS URL scoped to the container**: open the container → **Shared access tokens** (or **Generate SAS** at the container level) → grant **Read**, **Write**, **Create**, **List**, and **Delete** permissions (List + Delete let Backup clean up recordings for sessions you've since deleted locally; without them, backup/restore still work, just without that cleanup), pick an expiry far enough in the future, and copy the resulting URL (it looks like `https://<account>.blob.core.windows.net/<container>?sv=...&sig=...`).

**2. Connect it in Tuner**

1. Click **Cloud backup** in the top-right, paste the container SAS URL, and **Save**. It's stored only in this browser's localStorage, same as the Speech key.
2. **Backup now** uploads a manifest (folders, session metadata, scores) plus every recording (`.wav`) currently in your local history to the container, overwriting whatever backup was there before.
3. **Restore from Azure** downloads that backup and **replaces all local history in this browser** with it (you'll be asked to confirm, since this is destructive to whatever is only local).

**Notes / limitations**

- Backup always does a full re-upload of the manifest and every current recording; it does not diff against what's already on Azure. It also removes any recording on Azure that's no longer referenced locally (e.g. you deleted that session since the last backup) — this needs the SAS token's **List** and **Delete** permissions in addition to Read/Write/Create; without them, backup still succeeds, it just leaves those orphaned files in place and says so in the status line.
- Anyone with the SAS URL can read/write (and, with List+Delete granted, remove) your container until it expires, so treat it like a password (it's stored unencrypted in localStorage, same caveat as the Speech key above).
- A **Clear SAS URL** button removes it from local storage at any time; it does not delete anything already backed up on Azure.
- Sessions and recordings are keyed by a UUID (not a small counter), so their Azure blob path stays unique and stable even across browsers/devices. Any session saved before this was the case gets migrated to a UUID automatically, once, the next time you load the page — you'll see `Migrated N legacy session(s) to UUID ids.` in the browser console when that happens. The next Backup now after that re-uploads those recordings under their new path and cleans up the old one (needs List+Delete, per above).

## Running locally

Because it uses ES modules, serve it over HTTP (not via `file://`):

```bash
# either one
python3 -m http.server 8000
npx serve
```

Then open `http://localhost:8000`.

## Project layout

```
index.html          page structure
css/styles.css       design system
js/segment.js        sentence splitting
js/lang.js           language detection (ja / en)
js/config.js         Azure credential + Blob SAS URL storage (localStorage)
js/tts.js            TTS (Azure REST + browser fallback)
js/recorder.js       recording (Web Audio → 16 kHz WAV)
js/recorder-worklet.js  AudioWorklet capture processor
js/pron.js           pronunciation assessment (Azure REST)
js/store.js          local history persistence (IndexedDB: sessions + folders)
js/azure-blob.js     Azure Blob Storage REST client (backup/restore)
js/app.js            main application logic
```

## Browser requirements

- A modern browser (Chrome / Edge / Safari)
- Recording needs microphone permission; `getUserMedia` generally requires HTTPS or `localhost`

## License

MIT
