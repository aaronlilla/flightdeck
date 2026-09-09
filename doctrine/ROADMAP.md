# Roadmap

## The goal

Flightdeck takes any Jira board and any workflow it is pointed at, watches it and its error sources continuously, and turns every ticket into a merged PR handed to QA with the least wall clock and the fewest tokens, with no intervention from Aaron except to unblock something and to fix flightdeck itself. The conductor is a master of the board: it sees every new ticket, comment, alarm and error within one poll interval and acts on it. A blocker is the top priority the moment it exists. The current BBZ backlog is the first workload, not the design target.

Aaron, 2026-09-08. Only Aaron edits this paragraph.

## Items

| id | delivers | serves | status | pr | proof |
| --- | --- | --- | --- | --- | --- |
| R-01 | doctrine/ROADMAP.md exists with these sections | autonomy | running | this PR | file on main |
| R-02 | roadmap guards: briefs for this repo need a `roadmap: R-nn` line, `npm run check:roadmap` in verify, conductor parks off-roadmap lanes, self-loop findings without an id land under Proposed | autonomy | planned | | each guard shown red on a specimen |
| R-03 | design canvas of every console surface and dialogue | autonomy | done | https://claude.ai/code/artifact/1dad754e-dd7b-4c09-aa26-c09ba51a7737 | canvas saved 2026-09-08; Aaron's Claude Design revision imported to `doctrine/design/` |
| R-04 | the three UX rules as tests (identifier lint, one shared question card, one action per card state) | autonomy | running | | red on today's board, then green per fix |
| R-05 | auto-merge honours FORGE_COUNCIL_AUTOMERGE | autonomy | done | #77 | Q-56440c7b merged with mergedBy queue, PR #79 |
| R-06 | the packet carries comments, assignee and links; In Review/QA scopes from the last QA comment | autonomy | planned | | a specimen ticket in QA planned from its last comment |
| R-07 | `handoff` item kind: comment, assign, transition, done, no worktree | autonomy | planned | | a handoff item lands done with no worktree |
| R-08 | the handoff comment carries the worker's real visual plan; JoeHandoff posted on backend tickets; OTA outcome written back | autonomy | planned | | Haiping's ticket shows numbered steps |
| R-09 | decisions on evidence: `decide:` line, `## Decision` posted before launch | autonomy | planned | | a Lane A ticket whose first comment is the decision |
| R-10 | width 8 and the fixed two-by-four running grid with idle cards | clock | planned | | eight cards, idle slots say why |
| R-11 | intake bridge to the queue store; Jira watcher at 30 s; a comment on an owned ticket becomes a send; Done closes the lane | clock | planned | | a comment reaches its lane within one poll |
| R-12 | Sentry and CloudWatch feeds with watermarks and lane cards | any-board | planned | | a hand-flipped alarm is one event |
| R-13 | `event` kind: triage session, verdicts, `create` on the Jira client, form-shaped filing | autonomy | planned | | a synthetic Sentry issue becomes a ticket with a finding |
| R-14 | digest lane: noise ledger folded once a day into one Jira comment | tokens | planned | | the digest posts once with its card's count |
| R-15 | supply rule: blockers first, then the back-fill order | clock | planned | | a free slot fills in the stated order |
| R-16 | console surfaces rebuilt to `doctrine/design/Flightdeck Console.dc.html` | autonomy | planned | | the R-04 tests green and the console matches the design's Board, Chrome and Rail |
| R-17 | conductor tools: repo read, tests, forge CLI, every console route, self-brief authoring | autonomy | planned | | the conductor clears a blocker with no person |
| R-18 | project files and workflow discovery; every reader off FORGE_* | any-board | planned | | a second Jira project runs one ticket with no code change |
| R-19 | a worker's leftover uncommitted files never park the item at the gate | autonomy | running | | the two 2026-09-08 cases pass |
| R-20 | a goal-source item continues to its successor on a context handoff | autonomy | planned | | Q-17bb4283's shape passes |
| R-21 | the console cuts over to a new head on a quiet interval, not only when the queue is idle | clock | planned | | no hand restart after a merge |

## Not in scope

- Sentry and CloudWatch straight into the queue as their own items
- every event filing a ticket with no triage
- a new Intake view instead of lanes on the board
- a Conductor-rail-only event feed
- filing on the raw event with no investigation
- a decision sheet for Aaron instead of deciding on evidence
- the conductor editing the live console directly from chat

## Decisions

- 2026-09-08: product calls on Aaron's tickets are decided on ticket evidence, commented in his voice, built, reversible by reply.
- 2026-09-08: vendor-blocked tickets get the exact ask commented and are reassigned to the owner.
- 2026-09-08: Sentry and CloudWatch events are triaged and investigated, then filed as tickets in Harrison's form shape, noise to a daily digest.
- 2026-09-08: sources are lanes on the board.
- 2026-09-08: eight agents at all times as two columns of four, three watchers and five workers.
- 2026-09-08: every question in the UI is multiple choice with one recommended option.
- 2026-09-08: no identifier is ever a primary label.
- 2026-09-08: the conductor fixes flightdeck through the self loop, never by editing the live console.
- 2026-09-08: blockers outrank every ticket.
- 2026-09-08: per-board config in `~/.forge/projects/<KEY>.json` with workflow discovery.
- 2026-09-08: both merge allow-lists (`FORGE_COUNCIL_AUTOMERGE`, `FORGE_QUEUE_MERGE_REPOS`) must name a repo for it to auto-merge.
- 2026-09-08: the docs repository's roadmap on branch `docs/amp-g2-implementation` is retired by this file.

## Proposed

Self-loop findings that cite no R-id land here; only Aaron promotes them.

## How to use this file

- Read this file before any flightdeck work.
- Every brief carries `roadmap: R-nn`.
- A change to the goal paragraph without Aaron's own words in the commit is a defect.
- Update an item's status and pr in the same PR that changes it.
