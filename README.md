# Tuner

Tune your Japanese and English pronunciation against a native reference — read
aloud, shadow the reference voice, and score how close you got.

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

## Usage

1. Create a **Speech Service** resource in the [Azure Portal](https://portal.azure.com/) and get its **Key** and **Region** (e.g. `eastasia`, `japaneast`).
2. Open the page, click **Azure settings** in the top-right, enter the Key and Region, and save.
3. Paste text → Split → Speak / Record / Score per sentence.

> You can use it without a key: **Speak** automatically falls back to the browser's built-in voice (`speechSynthesis`), at lower quality.

## About your key (please read)

- The key is **stored only in the browser's localStorage** and is never uploaded to any server.
- This tool has no backend; requests go straight from the browser to Azure, so **your key is visible in the Network panel of the browser dev tools** — this is expected. It is your own key, and you are responsible for its usage and billing.
- A **Clear key** button lets you remove it from local storage at any time.

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
js/config.js         Azure credential management (localStorage)
js/tts.js            TTS (Azure REST + browser fallback)
js/recorder.js       recording (Web Audio → 16 kHz WAV)
js/recorder-worklet.js  AudioWorklet capture processor
js/pron.js           pronunciation assessment (Azure REST)
js/app.js            main application logic
```

## Browser requirements

- A modern browser (Chrome / Edge / Safari)
- Recording needs microphone permission; `getUserMedia` generally requires HTTPS or `localhost`

## License

MIT
