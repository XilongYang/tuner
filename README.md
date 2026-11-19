# Tuner

Pronunciation practice for Japanese and English: paste text or import audio, split it into sentences, hear a reference reading, record yourself, and get scored by Azure.

Data stays in the browser. Optional sync to Azure Blob runs automatically, guarded by a cross-device lock; everything can be exported to and imported from a zip. Static site, no backend, no build.

## Architecture

Plain ES modules served as-is; dependencies point downward only (enforced by `tests/arch.test.mjs`).

| Layer | Role |
| --- | --- |
| `js/model/` | Pure logic: schema, text segmentation, split/merge, conflict rules, scoring |
| `js/platform/` | Browser APIs: audio, recorder, player, hashing, zip, settings |
| `js/db/` | IndexedDB access and transactions |
| `js/cloud/` | Azure clients (Blob, Speech) and the sync planner/runner/lock |
| `js/app/` | Session store, autosave, and commands (split, practice, vocab, sync, archive) |
| `js/ui/` | DOM helpers and panels |
| `js/main.js` | Composition root wiring the layers together |

Sync is planned by a pure function (`cloud/sync/plan.js`) and then executed against a container object, so tests use a fake container instead of mocks.

## Development

```sh
npm install
npm test            # everything
npm run test:pure   # pure logic, no DOM
npm run test:e2e    # Playwright + Chromium (set CHROMIUM_PATH to use your own browser)
```

Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Deploy

```sh
npx wrangler deploy   # repo root is the site (Cloudflare Workers static assets)
```

## Azure

Speech synthesis, pronunciation assessment, transcription. Keys are entered in the app and stored only in the browser.
