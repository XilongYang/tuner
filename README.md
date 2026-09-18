# Tuner

A pronunciation-practice app for Japanese and English: paste text or import an
audio file, split it into sentences, hear a reference reading, record your own,
and get Azure's pronunciation assessment on it. Words you stumble over go into
a vocabulary library. Everything is stored locally in the browser; cloud sync
against an Azure Blob container is optional.

Static site, no backend, no build step: the browser runs the source as it is
served.

## Status

This branch is a rewrite. `docs/ARCHITECTURE.md` is the design it is being
built to, and explains why — the previous implementation worked but had grown
structural problems that a strict review traced to six specific causes, each of
which the new layout is shaped to make unrepresentable.

Built and tested so far:

| Layer | What is in place |
| --- | --- |
| `js/model/` | `content.js` (content-kind table), `schema.js` (entity definitions + derived representations), `geometry.js` (split/merge math), `merge.js` (conflict rules), `text.js` (segmentation, vocab keys), `transcript.js` (re-segmenting a transcription), `lang.js` |
| `js/platform/` | `hash.js` (content hashing, Blob rewrap/materialize), `audio.js` (resample, normalise, WAV encode, decode, cut clips), `recorder.js` (+ its worklet) |
| `js/db/` | `open.js` (`transact()`), `entities.js` (CRUD, atomic delete+tombstone, `applyPlan`) |
| `js/cloud/` | `blob.js` (`container(sasUrl)`), `speech.js` (`speechClient(credentials)`: synthesis, assessment, transcription), `sync/plan.js` (pure planner), `sync/run.js` (transfer, publish, orphan sweep), `sync/lock.js` (cross-device lock) |
| `js/ui/` | `dom.js` (`el`, `button`, keyed `reconcile`, `readNumber`) |

Not yet written: the live session store and commands, the panels, local
settings storage, playback, and `main.js`. The app does not run yet; what
exists is the foundation it will be assembled from, and all of it is tested.

## Running the tests

```sh
npm install
npm test        # everything
npm run test:pure   # model/ and the sync planner only -- no DOM, no IndexedDB
```

`npm run test:pure` needs no environment at all and finishes in well under a
second. That is where most of the logic lives and where most tests belong.

No test mocks a module, and no test needs an experimental Node flag: anything
that talks to Azure is handed a container object, so its tests pass
`tests/cloud/fake-container.mjs` instead.

`tests/arch.test.mjs` is not a unit test: it enforces the dependency direction
and purity rules in `docs/ARCHITECTURE.md`, so the document cannot quietly stop
describing the code.

## Deploying

The repo root is the site. `npx wrangler deploy` uploads it to Cloudflare
Workers static assets; `.assetsignore` keeps tests, tooling and `node_modules`
out of the upload.

## Azure services used

Speech synthesis (reference audio), pronunciation assessment (scoring), and
fast transcription (audio import). Credentials are entered in the app and kept
in browser storage; they are never committed.
