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

Built and tested so far — every layer, and the app runs:

| Layer | What is in place |
| --- | --- |
| `js/model/` | `content.js` (content-kind table), `schema.js` (entity definitions + derived representations), `geometry.js` (split/merge math), `session.js` (split/merge/edit transforms, by id), `merge.js` (conflict rules), `text.js` (segmentation, language and cut-position rules, vocab keys), `transcript.js` (re-segmenting a transcription, aligning a reading to its text), `voices.js` (the voices on offer), `lang.js` |
| `js/platform/` | `hash.js` (content hashing, Blob rewrap/materialize), `audio.js` (resample, normalise, WAV encode, decode, cut clips), `recorder.js` (+ its worklet), `player.js` (one sound at a time, owns object URLs, reports playback position), `speech-synthesis.js` (the browser's own voice, used without a key), `settings.js` (credentials, SAS URL, preferences) |
| `js/db/` | `open.js` (`transact()`), `entities.js` (CRUD, atomic delete+tombstone, `applyPlan`) |
| `js/cloud/` | `blob.js` (`container(sasUrl)`), `speech.js` (`speechClient(credentials)`: synthesis, assessment, transcription), `sync/plan.js` (pure planner), `sync/run.js` (transfer, publish, orphan sweep), `sync/lock.js` (cross-device lock) |
| `js/app/` | `store.js` (the session on screen), `persist.js`, `autosave.js`, and `commands/` — split, session, practice, vocab, sync, import-audio |
| `js/ui/` | `dom.js` (`el`, `button`, keyed `reconcile`, `readNumber`), `modal.js`, and the practice, library and settings panels |
| root | `index.html`, `css/`, `js/main.js` — the composition root that wires the layers together |

Not yet built, and still on the list from the previous implementation: the
folder tree in the library, `.tuner` backup export/import, and a word picker for
"Add vocab" (which currently offers the whole sentence). Migrating existing v5
data is an open question.

## Running the tests

```sh
npm install
npm test        # everything
npm run test:pure   # model/ and the sync planner only -- no DOM, no IndexedDB
npm run test:e2e    # the real app in a real browser, via Playwright
```

`npm run test:pure` needs no environment at all and finishes in well under a
second. That is where most of the logic lives and where most tests belong.

No test mocks a module, and no test needs an experimental Node flag: anything
that talks to Azure is handed a container object, so its tests pass
`tests/cloud/fake-container.mjs` instead.

`npm run test:e2e` serves the repo root exactly as it is deployed and drives it
with Chromium, so it covers what unit tests cannot: that the modules actually
load in a browser, that a reload comes back to the same session, and that a
failing service call is reported on screen rather than swallowed. Every one of
its tests asserts something. Set `CHROMIUM_PATH` to use a browser that is
already installed instead of Playwright's own download.

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
