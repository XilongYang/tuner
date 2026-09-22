# Reviews, and how work is done here

Two documents describe this codebase. `ARCHITECTURE.md` says what the design
is and why -- the layers, the invariants, the reasoning behind each. This one
says how the work gets done, and what three reviews of it actually found.

They are deliberately different in kind. Nothing here restates a design rule
that is already in `ARCHITECTURE.md`; a rule in two documents is a rule that
will be true in one of them. What is here instead is the process the work
follows, and a record of the mistakes, kept because the mistakes repeat in
shapes and the shapes are worth recognising.

## How a change is made

Every change follows the same route, and the route is the reason the reviews
below found what they found rather than something worse.

**The rule goes where it can be tested.** A rule in the composition root
(`js/main.js`) has no test and no reader: it is the one file nobody greps. Two
defects came from exactly there -- the hide-text switch that did not read the
session it came back to, and sync having no in-tab guard although
`cloud/sync/lock.js` says in as many words that the scheduler owns one. Both
fixes moved the rule out: into the subscriber that already existed, and into
`app/serialize.js`, which has tests because it is a module rather than a
closure in a 441-line file.

**A fix is not done until it has been removed again.** Every fix in the
reviews below was verified by putting the defect back and watching the new
test go red, then restoring the fix. A test written after a fix, against the
fixed code, asserts that the code does what it does. Two of the tests written
during these reviews passed against the broken code on the first attempt --
they were measuring the wrong thing, and would have been committed as
evidence of nothing.

**The comment carries the reason, not the mechanism.** What the code does is
readable from the code. Why it is this way -- what broke, what the alternative
cost -- is not, and is what the next change needs. A consequence: when the
code changes, the comment is part of the change. Three comments in these
reviews had outlived their code, including one asserting a focus behaviour
that was never implemented.

**Nothing that holds a device is left holding it.** A microphone, an audio
element, an object URL, a database connection: taken in one function, released
in another, and the release can arrive while the take is still in the air. The
second review found three of these, all the same shape.

**Tests run before anything is said about the change.** `npm test` (939) and
`npm run test:e2e` (32, real browser, real microphone via Chromium's fake
device). The browser suite is where recording, dragging and syncing are
actually exercised; a flaky one is treated as a defect in the test, not as
weather -- the one flaky test found here was a helper that opened a panel
twice and measured a row that the second repaint had replaced.

**Working files stay out of the repository.** Scratch, archives used to move
code between machines, probe scripts: `/tmp`, never the working tree, and
never `.git`.

**Commits are made only when asked, and stage named paths.** Never `git add
-A`, never `git add .`; `.claude/` stays unstaged. Each commit message says
what changed and why in prose, and ends with the attribution lines.

## What the reviews were

Three passes over the work of this session, after it was written and mostly
after it was committed.

1. **Against the document.** The new code read beside `ARCHITECTURE.md`,
   looking only for places where it contradicted what the document claims.
   Five findings.
2. **Function by function**, through `model/`, `app/`, `db/` and `platform/`,
   asking of each function what its edge cases are and running the answers
   rather than guessing them. Twelve findings.
3. **The remainder**: `cloud/`, the panels, `main.js`, the stylesheets. Eight
   findings.

Commits: `b74b431` (passes 1 and 2), `ea8e1a0` (pass 3).

## The shapes the defects came in

Twenty-five defects, and they were not twenty-five different mistakes. They
were seven, several times each.

### A fact kept in two places, and only one of them updated

The one that costs data. Dragging the open session wrote the new position to
the database while the copy in the store kept the old one -- and the store's
copy is what autosave writes next, with a newer clock, so the move was undone
by the next keystroke and the undoing is what reached the other devices. The
hide-text switch had the same shape: what it displayed came from the session,
what `startsHidden` read came from the stored preference, and the two could
disagree.

The fix in both cases is not to synchronise the copies but to have one place
decide and hand the answer to the other: `moveSession` now takes the store and
writes both with the same clock reading, because two copies of one session
disagreeing about *when* it moved is how the older one wins later.

### An await whose world changed underneath

`dispose()` during the microphone permission prompt: the continuation carried
on, set a disposed recorder recording, and left nothing holding the stream --
the browser's recording indicator stays on until the tab closes. Starting a
second clip while the first was still starting: pausing the first rejects the
`play()` promise it is still waiting on, and that failure path released
whatever was playing by then, which was the new clip. A library list read that
landed after the tab changed drew sessions into the vocabulary tab. A retest
recording into a row that survived the workspace being released.

The shape: between an await and its continuation, anything can have happened.
The remedy is the same every time -- after the await, check that this is still
the thing anybody wants, and own your own object rather than "whatever is
current".

### Loud where it should be quiet, quiet where it should be loud

The migration rewrote a record whose bytes it could not read, and `stripped`
took the inline value out with it -- destroying the only copy on the device,
in the one failure mode (see `db/content.js`) that usually succeeds on a fresh
connection. That is a quiet failure that should have been loud, and it was the
worst thing found.

The mirror: one unreadable blob in the container threw, which ended that sync
round and every round after it, with no way out but deleting everything in the
cloud. A failed `openDb` was cached for the life of the page, so one blocked
open left storage dead with no retry. Both are loud failures that should have
been local.

The rule that came out of it: fail loudly when continuing would lose
something, quietly and locally when continuing costs only that one thing.
A corrupt manifest still fails the whole round, deliberately -- it is what
every record and clip is listed in, and a device that treated it as absent
would publish its own over the top and sweep everything the others had.

### Two rulers against one text

`model/transcript` counted positions in UTF-16 units while everything else in
the app counts characters, so one astral character put every later word span
out by one -- cut markers in the wrong gaps, audio cut from the wrong moment.
A character that lowercases to two desynchronised the projection from its way
back and produced a span with no end. The vocabulary picker sized its coverage
map in units and read it with character indices.

Separately, the same shape in numbers: a score's colour came from the
unrounded value while the number printed beside it was rounded, so 79.5 drew
as "80" in the 60-79 colour, three lines above a legend saying 80 is good.

### Order read from something that changes

The session list was read in `updatedAt` order, so renaming moved a row. Fixed
once by giving sessions a position of their own -- and then the vocabulary
list, added the same day, was read in `updatedAt` order too, so covering a word
moved it. The second one was mine, made immediately after fixing the first.

### Two devices that never agree

An occurrence had no clock of its own (`OCCURRENCE.clock` named `updatedAt`, a
field it does not have), so re-picking a word left each device holding its own
snapshot and audio hash forever, and every round saw the manifest as changed.
A merge whose clocks tie kept "whichever side was passed as local", which has
the same effect. The sync lock deleted unconditionally whenever the ETag was
absent -- which a CORS rule that does not expose ETag makes it, every time --
so a device whose lock was stolen would delete the new owner's.

Convergence needs both devices to compute the same answer from the same
inputs. Ties break on something both sides can see: the serialized node, or
the id.

### A comment that outlived its code

Merge seams described as surviving a split that no longer records them. The
vocabulary picker's "an occurrence is append-only, so there is nothing to
recognise a repeat by", in three places, after occurrences became keyed by
where they came from. A drag handle promising to keep the focus, with no
`focus()` anywhere. `mergeWords` saying a merge concatenates with no
separator, while its caller passes one.

### Said but never done

`.btn.is-playing` styled in the stylesheet with nothing setting the class, so
no button ever showed that pressing it again would stop it. `input.is-key`
styling a field that became a password input. `cloud/speech.js` sending every
request with no deadline, in a layer whose sibling opens by explaining why
there has to be one.

## Index

Where each defect was, and what pins it now. Modules and function names rather
than line numbers, so this stays true as the files move.

| Where | What | Pinned by |
| --- | --- | --- |
| `db/migrate` `migrateInlineContent` | Rewrote a record whose bytes failed to read, destroying the only copy | `tests/db/migrate`: bytes still inline after a failed read; the next run finishes it |
| `app/commands/order` `moveSession` | The open session's copy kept the old position; autosave wrote it back | `tests/app/order-command` |
| `app/store` `commit` | A save write-back counted as movement, cancelling a split in flight | `tests/app/store` |
| `app/autosave` `flush` | Awaited the running save, not the one coalesced behind it | `tests/app/autosave` |
| `model/schema` `OCCURRENCE` | No clock of its own, so two devices never converged on a re-picked word | `tests/model/merge` |
| `model/merge` `mergeEntity` | A tie kept the local side, so neither device ever won | `tests/model/merge` |
| `cloud/sync/run` `transferContent` | An unreadable blob ended every round from then on | `tests/cloud/run` |
| `cloud/sync/lock` `release` | Deleted unconditionally whenever the ETag was absent | `tests/cloud/lock` |
| `cloud/blob` `downloadJsonConditional` | A corrupt body surfaced as a bare syntax error | (message only; the round still fails, deliberately) |
| `cloud/speech` `post` | No deadline on any request | `tests/cloud/http`, `tests/cloud/speech` |
| `db/open` `openDb` | A failed open was cached for the life of the page | (read; no test -- see Open items) |
| `model/content` `contentPath` | Built paths out of refs missing a part | `tests/model/schema` |
| `platform/recorder` `start` | `dispose()` during the permission prompt left the microphone on | `tests/platform/recorder` |
| `platform/player` `play` | A second clip was killed by the first call's failure path | `tests/platform/player` |
| `model/transcript` `project` | Counted UTF-16 units where the app counts characters | `tests/model/transcript` |
| `model/score` `accuracyLevel` | Banded the unrounded score, printed the rounded one | `tests/model/score` |
| `model/text` `detectLang` | Halfwidth katakana was not kana | `tests/model/text` |
| `model/order` `between` | Answered with a key past the upper bound for an input it cannot subdivide | `tests/model/order`, `tests/app/order-command` |
| `app/commands/vocab` `list` | Read in `updatedAt` order, so covering a word moved it | `tests/app/vocab-command` |
| `main.js` sync scheduling | No in-tab guard; a manual round was refused by this device's own lock | `tests/app/serialize` |
| `main.js` hide-text switch | Did not read the session reopened at startup | `tests-e2e` |
| `ui/panels/library` `refresh` | A list arriving after the tab changed drew into the wrong tab | `tests/ui/panels` |
| `ui/panels/practice/score` `finishRetest` | A stop that threw left the recorder unreachable and recording | `tests/ui/practice-panel` |
| `ui/panels/practice/panel` `release` | Did not stop a retest in a row that survived the release | `tests/ui/practice-panel` |
| `ui/panels/settings` sync buttons | No catch, so the status line sat on "Syncing…" for good | `tests/ui/panels` |
| `ui/masked-text` | `role="button"` on text with nothing to press | (read) |
| `ui/panels/practice/vocab-picker` `unplaced` | Coverage map sized in units, read in characters | `tests/ui/vocab-picker` |
| `ui/panels/practice/row` | `.btn.is-playing` never set | `tests/ui/practice-panel` |

## Open items

Known, judged, and not done. Each is here so that the next person decides
rather than rediscovers.

**`renameSession` lives in `main.js`.** It is the only write to the database
from outside `app/commands/` -- one `grep` confirms it. It is correct today
(it does update the store's copy), but it is the same shape as the
`moveSession` defect above, kept in the file with no tests and no readers. The
fix is three lines and a test.

**`ui/panels/library/panel.js` holds two lists.** Since the sidebar took over
the tabs, the sessions list and the vocabulary list share nothing but a DOM
element -- and that sharing is exactly why the panel needs a generation guard
on its repaints. Two panels would not need one.

**`main.js` is the largest module in the tree.** A composition root that size
is where rules hide; two defects above were found in it, and one more (the
sync guard) was only testable after being moved out.

**`ui/modal.js` has no focus trap**, while claiming `aria-modal="true"`. Tab
reaches the page behind the dialog.

**`audioPathKey` is the one plain field with no default**, an exception to a
rule stated in `ARCHITECTURE.md`. It is deliberate and pinned in
`tests/model/schema`, and now guarded at the point where it would do harm, but
it remains an exception a reader has to be told about.

**About a third of the invariants in `ARCHITECTURE.md` have no machine
check.** The document says what a convention is worth: a rule in the state
just before it is broken. Several of the defects above were conventions.

**The vocabulary list has two ways to reveal a word**: the per-entry stored
`hidden`, and a click that reveals until the list is next built. Both are
useful; two mechanisms for one idea is how the next reader gets confused.
