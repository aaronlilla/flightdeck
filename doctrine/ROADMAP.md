# Roadmap

## The goal

Flightdeck takes any Jira board and any workflow it is pointed at, watches it and its error sources continuously, and turns every ticket into a merged PR handed to QA with the least wall clock and the fewest tokens, with no intervention from Aaron except to unblock something and to fix flightdeck itself. The conductor is a master of the board: it sees every new ticket, comment, alarm and error within one poll interval and acts on it. A blocker is the top priority the moment it exists. The current BBZ backlog is the first workload, not the design target.

Aaron, 2026-09-08. Only Aaron edits this paragraph.

<!-- goal-sha256: 87fdcb9e0778c4432fdd75c3709d69394a97ed4936ebee29f1ad7f8cfd8c8bf8 -->

## Items

| id | delivers | serves | status | pr | proof |
| --- | --- | --- | --- | --- | --- |
| R-01 | doctrine/ROADMAP.md exists with these sections | autonomy | running | this PR | file on main |
| R-02 | roadmap guards: briefs for this repo need a `roadmap: R-nn` line, `npm run check:roadmap` in verify, conductor parks off-roadmap lanes, self-loop findings without an id land under Proposed | autonomy | review | #88, #91 | guard #1 (brief line), guard #2 (`check:roadmap` in verify), guard #3 (off-roadmap lane park), guard #4 (Proposed routing) all shown red on a specimen then green |
| R-03 | design canvas of every console surface and dialogue | autonomy | done | https://claude.ai/code/artifact/1dad754e-dd7b-4c09-aa26-c09ba51a7737 | canvas saved 2026-09-08; Aaron's Claude Design revision imported to `doctrine/design/` |
| R-04 | the three UX rules as tests (identifier lint, one shared question card, one action per card state) | autonomy | running | | red on today's board, then green per fix |
| R-05 | auto-merge honours FORGE_COUNCIL_AUTOMERGE | autonomy | done | #77 | Q-56440c7b merged with mergedBy queue, PR #79 |
| R-06 | the packet carries comments, assignee and links; In Review/QA scopes from the last QA comment | autonomy | planned | | a specimen ticket in QA planned from its last comment |
| R-07 | `handoff` item kind: comment, assign, transition, done, no worktree | autonomy | planned | | a handoff item lands done with no worktree |
| R-08 | the handoff comment carries the worker's real visual plan; JoeHandoff posted on backend tickets; OTA outcome written back | autonomy | planned | | Haiping's ticket shows numbered steps |
| R-09 | decisions on evidence: `decide:` line, `## Decision` posted before launch | autonomy | planned | | a Lane A ticket whose first comment is the decision |
| R-10 | width 8 and the fixed two-by-four running grid with idle cards | clock | planned | | eight cards, idle slots say why |
| R-11 | intake bridge to the queue store; Jira watcher at 30 s; a comment on an owned ticket becomes a send; Done closes the lane | clock | review | #97, #100 | a comment reaches its lane within one poll |
| R-12 | Sentry and CloudWatch feeds with watermarks and lane cards | any-board | planned | | a hand-flipped alarm is one event |
| R-13 | `event` kind: triage session, verdicts, `create` on the Jira client, form-shaped filing | autonomy | planned | | a synthetic Sentry issue becomes a ticket with a finding |
| R-14 | digest lane: noise ledger folded once a day into one Jira comment | tokens | planned | | the digest posts once with its card's count |
| R-15 | supply rule: blockers first, then the back-fill order | clock | planned | | a free slot fills in the stated order |
| R-16 | console surfaces rebuilt to `doctrine/design/Flightdeck Console.dc.html` | autonomy | running | PR #93 (1/3, tokens+Chrome) | the R-04 tests green and the console matches the design's Board, Chrome and Rail |
| R-17 | conductor tools: repo read, tests, forge CLI, every console route, self-brief authoring | autonomy | planned | | the conductor clears a blocker with no person |
| R-18 | project files and workflow discovery; every reader off FORGE_* | any-board | planned | | a second Jira project runs one ticket with no code change |
| R-19 | a worker's leftover uncommitted files never park the item at the gate | autonomy | running | | the two 2026-09-08 cases pass |
| R-20 | a goal-source item continues to its successor on a context handoff | autonomy | planned | | Q-17bb4283's shape passes |
| R-21 | the console cuts over to a new head on a quiet interval, not only when the queue is idle | clock | planned | | no hand restart after a merge |
| R-22 | the Merge click lands through git (fetch, squash, commit, push) instead of `gh pr merge`, so a GitHub mutation rate limit never blocks a reviewed PR; gate/council/PR-discovery still call `gh` (not yet moved off the API) | autonomy | review | this PR | real bare-remote fixture: item reaches done, mergedBy queue, base ref advanced, gate never called |
| R-23 | `forge clock` report: critical path per item, worker vs runner suite runs, tick stall | clock | planned | | a run of `forge clock` prints per-item hop medians and the critical path |
| R-24 | concurrent item advance; Codex lane runs beside the lenses | clock | planned | | a 21-minute council round no longer holds every other item's launch, status read and gate |
| R-25 | the runner's verification is the one full run; worker limited to targeted tests by rule; suite output to file | clock, tokens | planned | | full-suite runs per item drop to one runner run plus CI |
| R-26 | warden stale-session joins run state (open tool call, pid) into the process loop; tool-budget kept | autonomy | planned | | a worker inside a long sanctioned Bash call is never parked as stale |
| R-27 | pending checks are a wait state; rebase only when behind | clock | planned | | review→end median moves toward CI duration, no park on a still-running check |
| R-28 | queue passes the risk decision to council (no forced Codex); changed-lines count excludes lockfiles; small-PR path proven | tokens | planned | | a 20-line non-risky RN PR plus a lockfile change sizes as small |
| R-29 | self loop records a refusal once and re-checks on head change | tokens | planned | | `self.merge-refused` stops re-polling every 5 minutes on an unchanged PR |
| R-30 | ticket planning retries a transient fetch; reason on the fleet row | clock | planned | | a `fetch failed` plan hop retries with backoff instead of failing the item |
| R-31 | warm-template provisioning by copy | clock | planned | | a matching `package-lock.json` hash skips `npm ci` for a copy |
| R-32 | burn.mismatch once per change; cached journal readers | clock | planned | | `burn.mismatch` rows drop to one per run per changed value |

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
- 2026-09-09: Codex lane is risky and large diffs only, except when it's something that deals with money, which always needs the highest and most aggressive review (Aaron). Money paths always get the full council — 3 lenses, Codex lane, Opus judge, all fix rounds — regardless of size.
- 2026-09-09: R-23 to R-32 promoted from the wall-clock audit; first wave R-23 to R-26.

## Proposed

Self-loop findings that cite no R-id land here; only Aaron promotes them.

## How to use this file

- Read this file before any flightdeck work.
- Every brief carries `roadmap: R-nn`.
- A change to the goal paragraph without Aaron's own words in the commit is a defect.
- Update an item's status and pr in the same PR that changes it.
