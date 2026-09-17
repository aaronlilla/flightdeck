# The operator experience

How Aaron uses flightdeck from opening the app to a merged PR handed to QA. Decided with
Aaron on 2026-09-11; his words are quoted where they are the rule. This file is the spec
the R-74 to R-78 briefs build to. The goal paragraph in `../ROADMAP.md` outranks it.

## The day

1. Open the app and read one sentence: "9 in flight, 2 merged since 07:10, 1 needs you,
   feed live 0.4 s". Below it, the one thing that needs Aaron, with the recommended answer
   first. Nothing needing him means he closes the laptop.
2. Click a ticket and see its pipeline as a live graph. The active node pulses, finished
   nodes carry elapsed time and tokens, a waiting node says what it waits on. Click a node
   for the evidence behind it.
3. Repairs the machine made are badges on the node it repaired ("stalled 12:04, nudged,
   resumed"), so he sees that it caught them.
4. A question is one click. If he cannot answer it, he passes it to the teammate who can,
   from the same card, and the answer comes back on its own.
5. Merge, deploy and the QA handoff are nodes like any other. A ticket reaches Done with no
   hands, and the graph shows every hop.
6. The Machine page is the wiring: accounts, sessions, worktrees, processes, live.
7. Any row scrubs back through its own history.
8. Only a new question notifies him. Nothing else ever does.

## Decisions (Aaron, 2026-09-11)

- "the graph should replace the board"
- "questions need to be asked differently somehow than they are now"
- "the chat needs to be much more readable and usable without the constant verbose spam"
- "the chat needs to default to hugging the bottom of the chat until you scroll up with a
  fast scroll-to-bottom functionality that keeps it sticking to the bottom, like normal
  chatroom style"
- "extremely obvious and LIVE with high realtime accuracy of what exactly is going on at
  any given time"
- Status leaves the chat entirely. It renders on the graph.
- Questions to Aaron: one at a time, in a strip at the top.
- Planning is an adversarial interview: "ask questions that need to be answered to
  correctly create the plan and get all information necessary." Questions he cannot
  answer are passed, by a click on the card, to a named teammate (Jason, Joe, Haiping,
  Harrison) in a dedicated Slack channel with an @mention. The passing is "not automated".
- The answer comes back on its own: flightdeck reads the Slack thread reply.
- The graph is drawn with React Flow (xyflow).
- First wave: the rail and the strip (R-75) with the interview and the Slack pass (R-76),
  in parallel. The Flow page (R-74) with its manual stage gates (R-79) is the second wave.
- Manual first: every stage is a button with an auto toggle, off by default (§9).
- Optimistic everywhere: the click lands before the round trip, the server accepts then
  works, a failure rolls back inline with the reason (§10, R-80).
- Frontend only: backend questions default to Joe, product questions to Jason, and a
  backend-only ticket goes to the backend handoff instead of the interview (§9).

## 1. Screens

Four tabs replace six: **Flow**, **Machine**, **Review**, **Settings**. Board, Queue and
Blockers fold into Flow: the queue is the set of rows, blockers are the red nodes, the
width stepper and pause move to the Flow header. The conductor rail stays on every tab,
conversation only.

Above the tabs on every screen sits the **Needs you** strip. It is the largest element on
the page whenever it holds a question and collapses to one line ("Nothing needs you") when
it does not. The window strip carries the one-sentence machine state and the feed lag.

## 2. Flow: one live graph row per ticket

Each ticket is one horizontal React Flow graph. Rows sort needs-you first, then running,
then waiting, then finished today. The node set is fixed, left to right:

```
Intake → Plan → Worktree → Worker → Verify → PR → [CI ‖ Council] → Merge → Deploy → Handoff → Done
```

Node states, exactly one per node: `idle`, `active` (the edge into it animates), `done`
(elapsed and tokens under it), `waiting` (what it waits on, and the elapsed wait; the
median for that hop once `forge clock` (R-23) exists), `failed`, `needs-you` (warn border;
the strip's current question points here).

Repair badges sit on the node they repaired and come from journal rows that already exist:
`warden.*` (nudged, parked, resumed), `queue.fix-round`, `queue.recouncil`,
`queue.duplicate-launch`, account switch rows, `queue.pending-checks` past its cap.

Clicking a node opens the evidence sheet for that hop. Worker: transcript tail and tools.
Verify: suite output. PR and CI: the PR, its checks. Council: the verdict and findings.
Handoff: the Jira comment as posted. This replaces `TicketSheet.tsx` as the detail
surface; the lane composer ("talk to this worker") moves into the Worker node's sheet.

A scrubber under a row replays the row from the journal. Replay is already how `RunState`
is built (`src/forge/journal.ts`), so the scrubber is a `seq` ceiling on the fold.

Node to data (today's names, `src/shared/console-model.ts` and `src/forge/intake/queue.ts`):

| node | enters on | leaves on |
| --- | --- | --- |
| Intake | ticket item added (`addTicketItem`) | `queue.planning` |
| Plan | `queue.planning` | `queue.planned` (or `needs-you` while an interview question is open) |
| Worktree | provision hop | `queue.launched` |
| Worker | `run.started` | `run.handoff` or the run's verdict |
| Verify | runner suite start | suite result |
| PR | `pr` row / `queue.review` | checks reported |
| CI | `queue.pending-checks` | checks green or capped |
| Council | first council round | verdict row |
| Merge | merge hop | `queue.done` or park |
| Deploy | `otaVerify` start | OTA published or the 30-minute timeout row |
| Handoff | `jiraHandoff` start | comment, assign, transition all written |
| Done | `queue.done` | never |

Rendering: React Flow (xyflow), Industry tokens over its stylesheet, no pan or zoom on the
Flow page, fixed node positions per row. The parity screenshot set gains a twelve-row
fixture; the design is wrong if that fixture cannot be read at a glance at 1440×900.

## 3. Needs you: one question at a time

The strip shows one question: the ticket, the node that asked, the question, the evidence
behind a disclosure, the options with the recommended one first, keys 1 to 4, a free-text
field, and "1 of 3" with previous and next. Answering advances to the next question.

Every card carries **Pass to…** with the four names. Clicking posts the question to
`#fd-questions` with that person @mentioned, written in Aaron's voice, and moves
the card to `passed`, showing who holds it and for how long. Nothing is posted without the
click.

When the teammate replies in the thread, flightdeck reads the reply, attaches it to the ask
as the answer, and the node resumes. **It answers them in the same thread** (Aaron,
2026-09-11: "the person who replied needs to get feedback that the system got their
reply"): one sentence saying it has the answer and what happens next, naming the ticket in
plain words. A reply it cannot read as one of the options gets the other sentence, saying a
person is reading it. One acknowledgement per reply, never two, and none for a reply from
somebody the question was not passed to. A reaction would be cheaper and is not used: the
bot holds `chat:write`, `groups:history` and `groups:read`, so adding one fails at run time
for a missing scope, while a threaded message needs none. The card reads "Answered by Joe 14:02" with the reply.
A reply that is not a clean answer to the options comes back to Aaron with the reply
attached; the machine never guesses which option a sentence meant.

The chat no longer renders question cards. `ask.raised` rows (`src/forge/inbox.ts`) drive
the strip and the node state only. Confirms and blockers are Needs-you cards of their own
kind; the strip orders blockers first, then confirms, then questions, oldest first within
a kind.

The existing `Need` builder (`src/console/components/NeedsYou.tsx`, `buildNeeds`) is the
seed: it already reads a lane's question, options and ask key. The strip extends it with
`passed` and the kinds above rather than adding a second builder.

## 4. Planning as an adversarial interview

The planner (`src/forge/intake/planner.ts`) becomes two calls.

1. The interviewer, on the `plan` class, reads the packet and the scout's repo facts and
   returns up to four questions, each tagged `answerable-by: repo | aaron | teammate`, and
   for a teammate question, who. Repo questions go to a scout pass (a Sonnet call with
   read access to the checkout) and never reach a person. Aaron and teammate questions go to
   the strip.
2. The brief writer runs once the answers exist and records each question, its answer and
   who gave it under a `## Decisions` heading in the brief, so the worker and the council
   see the trail.

An open question parks the ticket at Plan (`needs-you` on that node), never the machine:
other rows keep moving. A question the interviewer can decide from evidence is a
`## Decision` line, not a question (R-09 stands).

## 5. The chat rail

Content: operator messages, conductor replies, agent replies, receipts with Undo. Nothing
else. Status, PR, event, activity, plan, confirm, blocker and decision rows leave the rail:
confirms and blockers become Needs-you cards, the rest are node state. `thread.ts` stops
building them for the rail; they still exist as journal rows for the graph.

The rail opens scrolled to the bottom and stays pinned while the reader is at the bottom.
Scrolling up unpins; a "↓ N new" button on the bottom edge jumps back and re-pins. This
replaces `FD Rail.dc.html` 1a ("opens at the top").

One line per message by default: a reply longer than two lines shows its first sentence
with a disclosure. Tool-call lists never appear in the rail. The composer stays; the
recipient switch (conductor or the agent on a lane) moves to the Worker node's sheet.

## 6. Live

The socket (`/events`, `src/console/ws.ts`) carries journal rows themselves (`event`,
`seq`, `at`, `ticket`, `run`, and the fields the graph reads) as deltas, filtered
server-side to the event names the graph folds. Slice invalidations stay for the pages that
still read slices; the full refetch stays for reconnect; the 5 s poll stays as the backstop.

Every node shows "as of hh:mm:ss" on hover. The window strip shows feed lag, the time from a
row's `at` to its receipt. Feed lost greys the Flow page within 2 s of the last heartbeat
and every node keeps its last-known stamp. A 1 s client tick moves elapsed times.

## 7. Machine as a wiring graph

The Machine page becomes a React Flow graph: accounts (with their limit bars) → sessions →
worktrees → processes, locks drawn as edges. Observation only, as decided on 2026-09-10. A
session the stall detector doubts is marked there before it is parked.

## 8. Push

A new Needs-you card raises a Windows toast from the desktop app. Nothing else ever does.
Phone delivery is a later item.

## 9. Manual first, automation later

Aaron, 2026-09-11, on the re-sync and start button: "i highly doubt the internal process is
actually how im envisioning it. these steps need to be manually triggered i think for the
most part, and then maybe later we can automate the entire thing completely." What he
needs to do today, in his words: "ingest jira, get 4 tickets loaded, get them planned out
in a planning session, a goal created, the goal automatically loaded up into a new agent,
goal finished, merged, pushed."

So every stage of a row is a gate with a button, and the default is manual:

| stage | button | what it does | auto later |
| --- | --- | --- | --- |
| Ingest | Pull tickets | reads Jira with the watcher's scope, loads up to the width (4 today), nothing else runs | the 30 s watcher |
| Plan | Plan | runs the interview (§4); the row waits at Plan until every question is answered | on ingest |
| Goal | Write goal | writes the brief from the answers; shows it in the evidence sheet | on last answer |
| Launch | Launch agent | provisions the worktree and starts the worker on the brief | on goal written |
| Work | none | the worker runs; the node shows step and context | |
| Verify, PR, CI, Council | none | the gates run as today | |
| Merge | Merge | merges through git (R-22) | allow-listed repos |
| Deploy | none | OTA or rebuild verified as today | |
| Handoff | Hand off | Jira comment, assign, transition | on merge |

Each stage has an auto toggle beside its button, off by default, per board. A stage with
auto on fires when the previous stage completes. Turning every toggle on is the fully
automated pipeline; nothing else changes. The Flow header keeps the width stepper and one
"Auto: N of 9" summary.

**Frontend only (Aaron, 2026-09-11).** "right now i was just given the directive that i need
to focus fully on the frontend, and defer all backend questions and implementation and
issues to joe and jason." So: a ticket the interviewer judges backend-only is not planned
here; it goes to the existing backend handoff (Joe) with the exact ask commented, and its
row stops at Plan with "backend: handed to Joe". A backend question inside a frontend
ticket is tagged `teammate` with Joe as the default name; a product question defaults to
Jason. The strip's Pass to… keeps all four names.

## 10. Optimistic everywhere, with the standard fallback

Aaron, 2026-09-11: "we need to have fully optimistic ui with the standard fallback routes.
when i interact with any action item, i want immediate obvious feedback. this also isn't
just a purely design visually, it's also changes to functionality in how we actually
ingest and the steps into actual implementation with the whole goal system and such."

The rule, for every action on every surface (a strip answer, Pass to…, a stage button, a
merge, a re-sync, a send in the rail):

1. **The click lands before the round trip.** The UI applies the expected result at once:
   the card advances to the next question, the node turns `requested`, the row moves, the
   message appears in the rail. A small pending mark (a dot on the element, never a
   spinner that blocks) says the server has not confirmed yet.
2. **The server accepts in one step and does the work in another.** Every command carries
   an `actionId`. The server journals `action.accepted` before doing anything and answers
   within 200 ms; the work itself runs on the tick or a worker and journals `action.done`
   or `action.failed` with a reason. No route ever blocks on a Jira read, a git call, a
   Slack post or a process sweep (the re-sync confirm dialog that blocked two minutes on a
   worktree sweep is the specimen this rule was written against).
3. **The fallback is standard.** `action.done` clears the mark. `action.failed` rolls the
   element back to its previous state and shows the reason inline on that element with
   Retry and, where the action was reversible, Undo. No acceptance within 2 s shows "not
   confirmed" on the element and keeps the optimistic state; the next slice read settles
   it either way.
4. **The stages follow the same shape.** Pull tickets, Plan, Write goal, Launch agent,
   Merge and Hand off are each an accepted intent: the node goes `requested` on the click,
   `active` on the tick that picks it up, then `done` or `failed`. The row is never frozen
   waiting on a modal.

The console store already tracks a pending key per control (`src/console/store.ts:147`,
`pending`, `action-pending`); today it renders "Working…" and waits. The change is that
the pending key applies the expected state and the journal rows reconcile it.

## Program

| id | stream | touches |
| --- | --- | --- |
| R-74 | Flow page | new `src/console/components/FlowView.tsx`, xyflow, row fold in `src/shared/`, delta rows in `server.ts`, evidence sheet, parity fixture |
| R-75 | rail and strip | `ConductorRail.tsx`, `NeedsYou.tsx` as the strip, `src/forge/console/thread.ts` |
| R-76 | interview and Slack pass | `planner.ts` two calls and scout, `inbox.ts` `passed` state, a Slack client (`src/forge/intake/slack.ts`): post on click, thread read-back |
| R-77 | Machine wiring graph | `MachineView.tsx` |
| R-78 | scrubber and push | Flow row scrubber, desktop toast |
| R-80 | optimistic actions | `actionId` on every command, `action.accepted/done/failed` rows, the store applies expected state on click and reconciles on the rows, inline rollback with reason, Retry and Undo; every route answers within 200 ms |
| R-79 | manual stage gates | a button and an auto toggle per stage on every row, default manual; Pull tickets, Plan, Write goal, Launch agent, Merge, Hand off; the backend-only route at Plan |

R-75 and R-76 run first, in parallel; they touch disjoint files, and the actions they add
(answer, pass) are optimistic from the start (§10). R-80 lands the general mechanism
before R-74 and R-79, which follow together: the graph and its buttons are one page.

The channel is `#fd-questions`, private, created by Aaron on 2026-09-11. R-76 needs a
Slack app with a bot token carrying `chat:write`, `groups:history` and `groups:read` (the
private-channel scopes), and the bot invited into the channel. The brief names the
environment variable. Until the app exists, the brief's proof is a Slack fixture; the live
proof step runs after.

## Claude Design prompt

For the three artboards this spec adds to the canvas (`FD Flow.dc.html`, `FD Strip.dc.html`,
a revised `FD Rail.dc.html`), Industry theme, 1440×900:

> Flightdeck console, Industry theme (Barlow, light ground, steel accent, square corners,
> registration marks). Three artboards. (1) Flow: twelve horizontal ticket rows, each a
> fixed node graph Intake, Plan, Worktree, Worker, Verify, PR, CI and Council side by side,
> Merge, Deploy, Handoff, Done; node states idle, active with an animated edge, done with
> elapsed and tokens, waiting with its reason, failed, needs-you with a warn border; repair
> badges on nodes; rows sorted needs-you, running, waiting, finished. (2) Needs-you strip
> above the tabs: one question, ticket and node named, evidence disclosure, options with the
> recommended first and keys 1 to 4, free text, "1 of 3" with previous and next, and a
> "Pass to…" button with four names; a passed state showing who holds it and for how long;
> the collapsed one-line state "Nothing needs you". (3) Conductor rail, conversation only,
> scrolled to the bottom, a "↓ 3 new" button on the bottom edge, one line per message with
> a disclosure on long replies, the composer.

## Alternatives rejected

- Status behind a filter in the chat: the spam is still generated.
- Hand-drawn SVG for the graph: Aaron chose xyflow.
- Questions inline on the node only: three open questions means three places to look.
- Passing a question to Slack automatically on a tag: the pass is a click.

## Unknowns

- Whether xyflow renders acceptably in the Electron shell under the Industry stylesheet
  without a fork of its CSS.
- Whether the journal row rate is low enough to stream filtered rows to the page; R-32's
  `burn.mismatch` half is still open.
- Whether flightdeck's own Slack app needs the pre-registration the Slack MCP client did.
- Whether one question at a time slows the day when several tickets ask at once; measured
  by time-to-answer in the journal.
