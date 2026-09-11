# The Flow program

How the Flow page gets built, in order, and how it is proven. Decided with Aaron on
2026-09-11. The page itself is specified in `operator-experience.md` sections 2, 6, 9 and
10; this file is the build order and the proof. Rows R-82 to R-88 in `../ROADMAP.md`.

## The proof this program exists to reach

Aaron, 2026-09-11: "i want to try it again with a new ticket and see it visually working in
this flow page end to end and make sure it works correctly at every step."

That is the acceptance for the whole program, and it belongs to him, not to an agent. A
real Jira ticket enters, and he watches its row cross every stage on the page, checking each
against what the machine did. No agent judges that; agents only make it possible and prove
the parts a test can reach.

Two things must already be true before that run is worth attempting: the pipeline can carry
one ticket end to end at all, which a separate session is establishing now, and the page
draws what the machine did rather than a plausible picture of it.

## What is missing, found by scouting main on 2026-09-11

**The planning records carry no ticket key.** Entering planning and waiting on an answer
both write records, 492 of them in the log, and every one carries an internal item id with
no ticket on it (`queue.waiting` keys: actor, asks, at, event, hop, id, itemId, seq,
version). A page grouping by ticket cannot attach them, so the Plan node would render
blank. R-82 adds the key; it is not only a derivation.

**A held item writes nothing per tick, by design.** `src/forge/intake/queue.ts:595` returns
early when the reason is unchanged, so an item waiting on an answer produces no records at
all. That is correct for the log and wrong for a page, and it is also why a stopped loop
looked identical to a quiet one today.

**The page's data does not exist.** Nothing records when a ticket entered or left a stage.
`QueueItem` (`src/shared/console-model.ts:707`) carries `createdAt`, `updatedAt`,
`handoffAt` and `mergedAt`, and nothing else with a time on it. Per-stage times are
reconstructable from journal rows, and `src/forge/console/story.ts` already does that ad hoc
for narration (`plannedAt` at 98, `launchedAt` at 104, `reviewedAt` at 121, `doneAt` at
187), by scanning for the latest matching row. Nothing stores it, nothing aggregates it,
and `forge clock` (R-23) was never built. **So the first goal is the data, not the page.**
A page built first would draw an invented timeline.

**The stage vocabulary disagrees with itself.** The code has six hops
(`HOP_NAMES = ['poll','provision','launch','gate','merge','jira']`,
`console-model.ts:30`), and `hopFor` projects a lane onto them (`lanes.ts:375`). The design
names eleven stages. One of them has to give, and the design's is the one a person reads.
R-82 maps the eleven onto what the journal actually records and keeps the six as an internal
detail; it never renames the existing hops, because other surfaces read them.

**There is no change stream.** The socket carries slice invalidations only
(`src/shared/console-events.ts:14-25`), and the client refetches a whole slice. Nothing
row-level or stage-level reaches the browser. Section 6's "live with real-time accuracy"
is therefore its own goal, not a property of the page.

**Three interface rules are red on main by design.** `tests/console/ux-identifier-lint`,
`ux-one-action-per-state` and `ux-question-contract` are written as expected failures: no
raw identifier visible to a person, one action per card state, every question through one
shared card. The Flow page's nodes and sheets must satisfy them rather than add new
violations, and turning them green is its own piece of work.

**Replacing three tabs breaks a pinned test.** `tests/console/design-surfaces.test.tsx:59`
asserts the exact six tab labels in order.

**No graph library.** React 19 and Vite 6, no React Flow of any version.

## The order, and why

Each row is one goal. The dependency is real in every case, not sequencing for its own
sake.

| id | goal | why it must come before the next |
| --- | --- | --- |
| R-81 | **A stopped queue loop is visible.** The loop that advances every ticket stopped today with nothing written anywhere, holding a real ticket whose questions were answered. Until a stop announces itself, no run of this program can be trusted to mean anything. | Nothing below can be demonstrated while a ticket cannot cross the pipeline. |
| R-82 | **The stage timeline.** One typed record per ticket saying when it entered and left each of the eleven stages, derived from journal rows, served beside the queue. Reuses `story.ts`'s scan rather than a second reader. | Without it the page has nothing true to draw. |
| R-83 | **The page, read-only.** React Flow, one row per ticket, six node states, repair badges, sorting, the empty row for a pulled ticket. Board, Queue and Blockers fold into it. No new buttons. | The buttons need somewhere to sit, and the live stream needs something to update. |
| R-84 | **The evidence sheet.** Clicking a node opens what that stage did: transcript tail, test output, the pull request and checks, the review verdict, the Jira comment. Replaces the current lane sheet. | Aaron's check-every-step run needs to see behind each stage, not only its colour. |
| R-85 | **Stage buttons and auto toggles** (spec section 9). Pull tickets, Plan, Write goal, Launch agent, Merge, Hand off, each with a toggle off by default. | Manual-first is how the end-to-end run is driven; it is the run's control surface. |
| R-86 | **Live rows** (spec section 6). Stage-level events on the socket, folded per row, with a staleness stamp and the page greying when the feed dies. | Watching a ticket cross the page needs the page to move within a second, not on a five-second poll. |
| R-87 | **The end-to-end run.** A real ticket pulled, planned, worked, merged and handed over, watched on the page by Aaron, every stage checked against what the machine did. | This is the acceptance for the program. |
| R-88 | **The scrubber and the notification** (R-78). Replay a row from its records; a new question raises a desktop notice. | Only worth building once the live view is trusted. |

R-81 comes first and blocks the rest, because the watched run at R-87 is meaningless if the
pipeline can stall silently. R-82 and the artboard work for R-83 can start together once it
lands. Everything else is a chain.

## What each goal must prove

Beyond its own tests, each carries a proof aimed at the failure this program is most
likely to have: a page that looks right and is lying.

- **R-82** proves the timeline against a real finished ticket's records, not a fixture
  alone: every stage's start and end reconciles with the rows the machine wrote, and a
  stage the machine never reached reads as never reached rather than as zero.
- **R-83** proves a twelve-row fixture reads at a glance at 1440×900, and proves a node
  with no data renders as unknown rather than idle. The screenshot comparison gains its
  board; the six-tab assertion is updated with the reason in the pull request body.
- **R-84** proves each sheet shows the stage's own evidence and never another stage's.
- **R-85** proves that with every toggle off nothing advances without a click, and with
  every toggle on a ticket reaches the worker with no click, both against a fake feed.
- **R-86** proves a stage change reaches the page in under a second against a fake
  journal, and that a dead feed greys the page within two seconds rather than showing
  stale state as current.
- **R-87** is Aaron's. The agents' part is a written list of what to check at each stage
  and what each should show.

## Decisions taken here

**A pulled ticket shows as a full row with every node idle** (Aaron, 2026-09-11). Something
must be visible before it is planned, or manual-first has nothing to click.

**No pan or zoom.** Fixed node positions per row, so the page can be compared against an
artboard and read without navigation.

**The eleven stages are the vocabulary a person sees.** The six internal hops stay as they
are; R-82 maps between them.

## Rejected

- Building the page first and adding real timing later. It would draw an invented timeline
  and every later correction would look like a regression.
- Keeping the board alongside the Flow page. Two surfaces showing the same work is how they
  disagree.
- Deriving stage times in the browser. The records are large and the browser would need the
  whole journal.

## This is wrong if

A ticket's stage times cannot be reconstructed from the journal without ambiguity, for
example when a stage is entered twice after a retry and nothing distinguishes the attempts.
R-82 finds that out first, against a real finished ticket, which is why it is first.

## Unknowns, named

- Whether React Flow renders acceptably inside the desktop shell under this design system
  without forking its stylesheet.
- Whether twelve rows are readable at once, which only the screenshot answers.
- What the separate end-to-end session finds; its answer may add a stage or show one that
  no record covers.
- Whether a retried stage needs its own node or a badge on the existing one.
