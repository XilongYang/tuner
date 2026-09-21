# Architecture

Tuner is a static, backend-free pronunciation-practice app: plain ES modules
served as-is (no build step), IndexedDB for local data, Azure for speech
services and optional cloud sync.

This document is the contract the code is held to. `tests/arch.test.mjs`
machine-checks the parts of it that can be checked, so the rules below cannot
quietly stop being true.

## Why this rewrite exists

The first implementation worked, and grew to ~8.6k lines of JS. A strict
review found that its defects clustered into six structural causes, not
scattered mistakes:

1. **One fact, four hand-written field lists.** A session/sentence/vocab
   record was enumerated separately in the IndexedDB record shape, the Azure
   manifest, the backup ZIP and the merge function. A field added to one and
   not the others silently dropped data, with no error anywhere. It happened.
2. **Six content kinds × five copy-pasted code sites.** Recording, reference
   audio, assessment, input text, source audio and vocab audio each appeared
   in five near-identical blocks inside one 600-line sync function. Every new
   kind was added by copy-paste-adjust, and the sixth one was added missing a
   guard the other five had.
3. **Modules that claimed purity while importing global mutable state.** The
   split/merge geometry — the most intricate logic in the app — declared
   itself "safe to unit-test directly in Node", could not be imported in Node
   at all, and therefore had zero tests.
4. **A global mutable state module as the dependency hub.** 21 exports, ~60
   DOM lookups, ten unrelated concerns, importing both the data layer and the
   sync layer, imported by everything. No acyclic direction was left.
5. **Destructive full repaints.** Every render replaced the whole list, which
   discarded in-progress selections, scroll position, open popovers and
   in-flight recordings — so other code grew workarounds to avoid rendering.
6. **Implicit coercion at boundaries.** A DOM `dataset` read of `''` became
   `Number('') === 0`, which downstream arithmetic accepted as a real
   timestamp and silently produced empty audio.

Each rule below exists to make one of those unrepresentable, not to be tidy.

## Layers

Dependencies point one way only. `tests/arch.test.mjs` enforces it.

```
model/      pure data + rules. Imports NOTHING outside model/.
platform/   thin wrappers over browser capabilities (mic, audio, playback, local settings).
db/         IndexedDB. Imports model/.
cloud/      Azure REST (blob, speech) + sync planning/execution. Imports model/.
app/        the live session store + commands (use cases). Imports model/, db/, cloud/, platform/.
ui/         DOM primitives + panels. Imports model/ and app/. NEVER db/ or cloud/.
main.js     composition root. The only module allowed to import every layer.
```

`model/` is the base of the pyramid: every layer may depend on it. It has no
dependencies of its own, so it cannot take part in a cycle, and the alternative
— forbidding, say, `platform/` from reading the locale codes — only duplicates
domain constants into the layers kept away from them.

Two consequences worth stating explicitly, because the previous design
violated both:

- **`ui/` cannot reach the database or the network.** It dispatches commands
  and subscribes to the store. This removes the need for the old `uiHooks`
  indirection (which existed so that `cloud/` could repaint panels): nothing
  in `cloud/` knows the UI exists, because the UI reacts to store changes.
- **No lateral panel imports.** Panels do not import each other. Mutual
  exclusion between sidebars is a property of the panel registry in
  `ui/panels/registry.js`, not something each panel implements by importing
  its sibling's close function.

## model/ — the load-bearing layer

Everything that can be a pure function of its inputs lives here, and is
tested with plain object literals: no DOM, no IndexedDB, no fakes, no module
mocking. This is where the majority of the tests live, because this is where
the logic that is actually hard lives (split/merge geometry, merge rules,
segmentation).

`model/` may not import outside `model/`. The test asserts both the import
graph and that every `model/` module can be imported in a bare Node process.

### schema.js — one definition per entity, every representation derived

An entity is defined once, as field descriptors:

```js
export const SENTENCE = entity('sentence', {
  id:     f.id(),
  text:   f.plain(),
  hidden: f.plain({ default: false }),
  words:  f.plain({ default: null }),
  recording:  f.content('recording'),
  assessment: f.content('assessment'),
});
```

`toRecord` / `toManifest` / `fromManifest` / `toBackup` / `fromBackup` are
generic over the descriptors. Adding a field is one line and reaches every
representation at once; there is no second list to forget.

Two distinctions the descriptors encode, because conflating them caused real
bugs:

- `f.plain()` vs `f.content(kind)` — a plain field travels inline; a content
  field never does. Only its hash travels, and the bytes live in their own
  blob (cloud) or ZIP entry (backup). The manifest's `has*` booleans are
  *derived* from the descriptors, not persisted locally, so the live record
  never carries a flag that can disagree with the bytes next to it.
- `default: null` is applied with `??`, never `||`. `0` and `false` are legal
  values for offsets, durations and `hidden`.

### content.js — the content-kind table

One row per blob-backed content kind, describing scope, blob path, encoding
and MIME type. Sync, backup and cleanup iterate this table; none of them
branch per kind. A seventh kind is one row plus one `f.content()` field.

### Word timings belong to the clip they were measured against

A sentence's `words` describe one recording of it and nothing else: a
transcript's timings are on the source file's timeline, a synthesized clip's
are on that clip's own. They therefore travel only onto a sentence that holds
the clip they describe, and every operation that changes the audio says so
explicitly:

- a split gives a half its share of the timings only if it gave that half the
  audio;
- a merge keeps them only when the merged sentence keeps a clip -- the re-cut
  source range, whose timeline they are already on;
- speaking a sentence again replaces the clip, so the old timings go with it.

Carried onto a sentence whose audio they no longer describe, they are worse
than absent: the cut markers then offer exact-looking timestamps into audio
that is not there, and the karaoke highlight follows the wrong words. Both
happened, which is why the rule is written here rather than left implied.

Where a join happened is a different kind of fact -- it is about the text --
so a merge seam survives either way, and only its timestamp goes with the
audio.

### geometry.js — split/merge math

Pure. Takes explicit values, never global state. In particular a split point
is `{ charIndex: number, ms: number | null }`, and `null` means "no timestamp
here" — not `0`. Functions that need a timestamp reject `null` explicitly
rather than doing arithmetic on a coerced zero.

## cloud/sync — decisions are pure, IO is a shell

Sync is split at the only seam that matters:

```
planSync({ local, remote }) -> Plan   // pure
runPlan(plan, io)                     // IO only, no decisions
```

`Plan` is plain data:

- `slots` — every content slot the result references, each carrying its blob
  path and one of four actions: `upload`, `download`, `reuse` (the bytes are
  already here) or `unresolved` (the hash names bytes neither side holds —
  reported rather than fetched, so corruption reads as a fault instead of a
  404 inside a loop). The action is derived from three hashes: merged, local,
  remote. Nothing records which side "won".
- `localWrites` — merged records, each with the `baseClock` it was planned
  against.
- `localDeletes`, `tombstones`, `manifest`, `manifestChanged`,
  `referencedPaths` (for the orphan sweep), `unresolved`.

Because planning is pure, the interesting scenarios — a field edited on both
sides, a delete racing an edit, a vocab entry whose occurrence lists diverged,
content present remotely but not locally, nothing changed at all — are tested
with object literals in microseconds, with no fake container and no jsdom.

`cloud/sync/run.js` carries the plan out — `transferContent`,
`publishManifest`, `readManifest`, `sweepOrphans` — and makes no decisions.
Applying the plan's local writes is deliberately *not* there: that belongs to
whoever owns the database, and `cloud/` must not reach into it. `db/entities.js`'s
`applyPlan` does it, in one transaction, skipping any record whose local clock
no longer matches the `baseClock` the plan carries. That check lives in exactly
one place for every entity kind. In the previous design it was hand-written per
kind, which is why the kind added last shipped without it and a mid-sync delete
could be resurrected.

### A hash is a claim, and a claim is never published without the bytes

A content hash is not metadata about bytes; it is the assertion that those
bytes exist and can be fetched. The manifest is that assertion published, and
the content plan is arithmetic on it.

So a round never publishes a manifest naming content that did not go up. A slot
whose bytes could not be sent is withheld from the published manifest, while
the local record keeps its hash unchanged. The alternative advertises a blob
that never arrived, and the device that owns it then reads its own claim back
as `reuse` and stops offering it, while every other device downloads a 404
forever. Withholding instead means the container claims only what it has, the
owning device offers the bytes again on every later round, and nothing is
discarded on the strength of one failed read — which matters, because an
unreadable Blob is sometimes readable again on a fresh connection.

An upload's deadline scales with its size, because a PUT's `fetch()` does not
settle until the body has gone out. A fixed timeout there is a bandwidth floor
dressed as a stall detector, and it only shows up when a round has to upload
everything at once — the first sync after the container is emptied.

### The container, and why no test mocks a module

`cloud/blob.js` exposes `container(sasUrl)`, returning the seven blob
operations already bound to that URL. Everything built on top — the lock, the
runner, a sync command — is *given* a container rather than importing one.

Two things follow. A SAS URL is never threaded through call after call. And
every test above the REST layer passes a plain in-memory object
(`tests/cloud/fake-container.mjs`) implementing those seven methods, so the
suite needs no module mocking and no experimental Node flag. That matters
because the previous suite did need both, and an ES-module import-hoisting
subtlety once made a mock silently fail to apply — leaving tests that reported
success while actually calling the network, which only surfaced when a
strengthened assertion printed a real HTTP 403.

`cloud/` therefore contains no browser reference at all (the blob listing
parses its XML by scanning rather than with `DOMParser`), and
`tests/arch.test.mjs` asserts both that every `cloud/` module imports in a bare
Node process and that no module outside `ui/` and `platform/` mentions a DOM
global.

The cross-device lock and orphan cleanup stay, unchanged in behaviour: they
are separate concerns with their own modules, and neither needs to be inside
the planner.

## db/ — bytes are written once

A record carries hashes. The bytes those hashes name live in their own store,
keyed by the same blob path the container uses, and are written exactly once:
when the content is produced. Reading joins the two back together, so nothing
above `db/` knows there are two places; writing separates them again.

This is not a layout preference, and not an optimisation. Measured in Safari 27
(the probe is `scratch/webkit-blob-repro.html`): a Blob stored in IndexedDB,
read back in a later page life and stored again as part of its record, fails
with `UnknownError: Error preparing Blob/File data to be stored in object
store` — after 11 re-stores in one run, 22 in another, never in a third — and
the failed write takes the stored copy with it, so the next read of that clip
is `NotFoundError: The object can not be found here`. Where the bytes came from
makes no difference; re-wrapping the Blob first (`new Blob([blob])`) does not
prevent it. Only never handing the engine back a Blob it gave you does.

The old design stored each Blob inside its record, and the record was rewritten
on every edit — every keystroke, every hidden toggle, every score. So the audio
was rewritten too, dozens of times per session, and one of those writes
eventually destroyed a clip that had been fine for weeks. Nothing noticed,
because the bytes were read exactly once (when hashed) and not again until a
sync had to upload them.

What follows from writing bytes once:

- `app/persist.js` is the only place bytes enter the store, and it writes a
  slot only when the content store does not already hold that hash. Everything
  else about a record may be rewritten freely.
- Bytes are materialized (`platform/hash.js`'s `materializeBlob`) before they
  are stored or sent: a Blob is a reference to somewhere the page does not own,
  and the content store holds no references to anywhere else.
- A sync round reads one slot's bytes when it uploads that slot, so a round
  does not hold a library in memory, and a clip whose bytes are gone is found
  as that rather than as a network error about the SAS URL.
- Deleting a record deletes its content in the same transaction, and
  `sweepContent()` collects what a split or a merge left behind — the same
  arithmetic as the container's orphan sweep, on the same paths.
- `db/migrate.js` moves version 1's inline content out, once, record by record.
  A slot whose bytes cannot be read is reported and keeps its hash: migration
  is the wrong moment to decide a clip was worthless.

## app/ — live state as a store, mutations by id

One subscribable store holds the session on screen. Every change is a named
mutation applied synchronously; each mutation bumps a version counter.
Mutations address sentences **by id, never by array index**, and long
operations follow: read snapshot → do async work → apply mutation, which
re-resolves ids and refuses to apply against a changed version. Two real bugs
in the previous design (an index captured before a multi-hundred-millisecond
audio decode, applied after) are unrepresentable in this shape.

Commands (`app/commands/*.js`) are the use cases the UI dispatches: split,
merge, record, score, import audio, sync, delete. A command is the *only*
place a workflow is defined, so no caller can hand-roll a partial copy of one
— which is how a sync-triggered "clear the workspace" ended up omitting three
of the eight steps its own function does and stranding the UI.

## ui/ — keyed reconciliation, shared primitives

`ui/dom.js` provides `el()`, `button()` and `reconcile(container, items,
{ key, create, update })`. Lists are reconciled by key: rows are created,
updated, moved and removed, never wholesale rebuilt. Selection, scroll
position, open popovers and in-flight recordings therefore survive a repaint
triggered by a background sync, and no module needs to avoid repainting.

There is exactly one modal primitive, with focus management and Escape
handling in it. (The previous design had three hand-rolled modals that had
already drifted apart on who removes the backdrop, what gets focus, and
whether Escape closes — with Escape working on a context menu but not on the
destructive "delete everything" dialog.)

Destructive actions share one confirmation path, and the strength of the
confirmation is proportional to what is destroyed.

Sync is the one thing the app does without being asked, so it has a permanent
place to say so: `ui/sync-indicator.js`, a dot and one of three words in the
masthead, with the round's full account on hover or focus. It renders a state
and decides nothing — which state a round is in comes from `main.js`, the one
place every round passes through. The wording lives in `ui/sync-text.js`,
shared with the settings panel, because the panel and the indicator describe
the same round and two copies of that vocabulary would drift. A round's
outcome is no longer also announced over the page: one fact, one home.

## Invariants, and what holds each one

Every rule this design rests on, and the test that fails when it stops being
true. An invariant with nothing under "checked by" is a convention, and a
convention is a rule in the state just before it is broken -- which is how the
clip-destroying write got in, under a comment asserting it could not happen.

Storage:

- A hash is non-null exactly when the record claims content; the value beside
  it may be absent, which means the bytes are not in hand. *(`app/persist`
  tests: a claim with no bytes is kept; a caller clearing content clears both.
  `db/entities` tests: a hash with nothing behind it reads back as a claim.)*
- Bytes are written once per path and hash, however often the record is
  rewritten. *(`app/persist` tests; browser test "a clip is written once".)*
- A stored record never contains bytes. *(`db/entities` test reading the raw
  record.)*
- A record and the bytes it brought land in one transaction, or neither does.
  *(`db/entities` test, forced with a record the engine refuses to serialize.)*
- A deletion and its tombstone land in one transaction. *(`db/entities`.)*
- Deleting a record deletes its content; content no record references is
  collected. *(`db/entities`; browser test "splitting a sentence collects the
  clip nothing references any more".)*
- Nothing but `db/entities.js` reaches the content store. *(`arch`.)*
- Version 1's inline content is moved out before any reader expects it in the
  content store. *(`db/migrate` tests; browser test that starts the app on a
  real version 1 database.)*
- An upgrade blocked by an older tab is reported, and a connection here lets go
  when another tab needs one. *(`db/open`.)*

Sync:

- The published manifest never claims bytes the container does not have: a
  failed upload ends the round before publishing, and content that could not be
  sent is withheld from the manifest while the local record keeps its claim.
  *(`app/sync-command`: an upload that fails publishes nothing; a withheld
  upload is offered again next round.)*
- A failed read never discards a claim, here or upstream. *(`app/persist`,
  `app/sync-command`.)*
- The round's order is lock, read, plan, upload, publish, write locally, sweep,
  release. *(`app/sync-command`: the order is asserted as a sequence.)*
- A local write whose record changed under the plan is skipped, and the bytes
  it downloaded are skipped with it. *(`app/sync-command`.)*

Model:

- Word timings belong to the clip they were measured against. *(`model/session`
  split and merge tests; browser geometry tests.)*
- A blob path is a function of kind and ref, and the same one locally and
  remotely. *(`model/schema`: a content field added reaches the manifest and
  the content walk with nothing else touched.)*
- Only identity has no default; every other field defaults, and no field
  serializes as `undefined` -- the one value JSON drops. *(`model/schema`: the
  required set is pinned, so adding a field without a default is a deliberate
  edit to that list.)*
- No `has<Field>` flag anywhere: a hash is the fact. *(`model/schema`.)*

App and UI:

- The session on screen is the only mutable state, and commands address
  sentences by id. *(command tests throughout.)*
- `ui/` never reaches the database or the network. *(`arch`.)*
- A session with nothing in it is not stored. *(`app/session-command`.)*

## Tests

Four tiers, in descending order of how many tests belong in each:

1. **Pure** — `model/`, `cloud/sync/plan.js`. Plain `node:test`, object
   literals, no environment. Fast; this is where coverage should concentrate.
2. **Store** — `db/`, against `fake-indexeddb`.
3. **Integration** — sync round-trips against an in-memory fake blob
   container; UI flows in jsdom. Few, but real.
4. **Browser** — Playwright. **Every browser test asserts.** The previous
   suite had 26 scripts that only printed what they observed and exited 0 on
   a wrong answer, so the split/merge audio invariants it appeared to cover
   were in fact unguarded.

`tests/arch.test.mjs` is not a unit test; it is the enforcement of this
document.

## Comment policy

A comment may state:

- an invariant the code depends on and cannot express;
- a non-obvious external constraint (an Azure format requirement, a browser
  bug being worked around);
- why an obvious alternative was not taken, in one line.

A comment may not: record history ("this bit us once", a date, who asked for
it), narrate a past refactor, or name a function in another module (rename it
and the comment becomes a lie — reference the module instead). Git already
stores history, and it stays true.

This is not a style preference. In the previous implementation three of the
confirmed bugs were sitting under comments that asserted those exact bugs
were impossible, and the comments are why nobody looked.
