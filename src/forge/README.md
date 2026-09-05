# forge

The runner that carries a goal across however many bounded sessions it takes, without ever letting a failure buy a bigger model.

## What a run guarantees

Each session has a token ceiling for its class, read from `model-policy.json` (triage, plan, implement, verify, and the rest each get their own `maxContext` and `maxTurns`). When a session crosses its ceiling, it does not retry or move up to a heavier tier. `worker.ts`'s docstring calls a goal "a chain of bounded sessions": at the ceiling "the worker asks the session to write a handoff packet and starts a successor seeded with it, on the same model." Model-tier selection reads no failure history, which is what makes "no escalation by retry" a property of the mechanism rather than a promise someone has to keep: `model-policy.json` states it directly with `"escalation": "never-by-retry"`. That is a separate counter from `sessionsSinceCommit`, which `worker.ts` does track and which parks a chain once three sessions in a row land no commit.

The successor's environment is the parent's, minus a fixed set. `worker.ts` copies the whole parent environment, then deletes nine inherited markers (the session id, the child-session flag, the PID, the effort level, the messaging socket and token, and the CLI identity markers) so a child cannot be mistaken for the session that spawned it. `ANTHROPIC_API_KEY` is deleted too, and separately: "not because it is one of the nine: with a key present the child bills the API account instead of using the subscription login." The config directory gets its own treatment. `launcher.ts` pins it rather than passing through whatever the parent had, because "sharing the interactive session's directory means the fleet writes into the store" the person at the keyboard is using.

## What the launcher refuses before a run starts

`checkLaunch` refuses an empty condition: "the condition is empty, so the goal has no way to end." In practice `forge run` never hits that branch, since it substitutes a default condition text before calling `checkLaunch`; the check only fires when something calls `checkLaunch` directly. A condition over the 4000 character limit is refused for real, so it can't get silently truncated instead of failing loudly. A launch is also refused while a `claude login` is in flight on the account, since "starting now races the credential this worker is about to use," and while the kill switch is engaged. A brief that opens a websocket Monitor is refused outright too: "a queued event kills a `-p` process mid tool call and a worker has no console to watch." `forge run` also refuses before any of this, at argument parsing, when `maxContext` or `maxTurns` doesn't parse: a NaN ceiling never fires.

## The kill switch

`forge stop --all` is the one command documented as having to work "when nothing else does." It does not kill outright. `Fleet.stopAll` walks every running lane and, for one it holds a live session for directly, sends the handoff request and waits, then stops the session either way. For the ordinary case, a `forge stop` invocation is its own process and "never holds another run's session", so it instead queues the same handoff request into that run's inbox for delivery on the run's next tool call, and records the lane as `reached: false` rather than assuming the park landed. The CLI's own help text states the goal, not a guarantee already met for every lane: it will "park every run with a handoff and end all spend."

## How a worker is spoken to

Two channels exist for two situations. An ordinary message to a running worker gets queued in a per-run inbox and rides along as `additionalContext` on that worker's next tool call. It is never delivered by interrupting the worker, and never denied: "a message is information, and turning it into a refusal would make telling a worker something an act of stopping it." A message sent while the worker is idle between tool calls just waits for the next one.

A question works differently. A worker cannot block on a prompt, so when one is raised, it is intercepted before it renders, written to a keyed inbox entry, and the run parks with its work committed and its lane released. An ordinary question, the kind `forge_ask` raises, is keyed on its goal, run, and action target together, so it gets its own entry even when another run asks the same words. A `blocker` ask, the kind `drift.ts` raises when a branch can no longer merge cleanly against its base or its mergeable state cannot be read at all, is keyed on wording alone, so every run stuck behind the same base shares one entry instead of one each. Answering an entry queues the resume text into the goal's own inbox (falling back to the run's, when an ask recorded no goal) and, when the same process still holds the live session, resumes it in place.

## What this module does not cover

`liveness.ts` describes itself, unactuated, as a pure sensor: "parks, kills and nudges nothing, that stays the Warden's job. This only watches and says so." That line covers the module only when no `WardenActuator` is wired in. Give it one, and `actOnStuck` does park a stuck run and flag its lane on an idle, tool-budget, or context trip, on the Warden's behalf rather than the module's own. Drift and blocker handling exist too, in `drift.ts`, and a console exists, served by `server.ts`. `contracts.ts` already names governor, intake, and council as event-bus roles, but as of this revision none of the three has an implementation under `src/forge/`; only the role name is there.

## Running it

```
npm run verify   # typecheck, console typecheck, tests, agnostic path check, fault injection
```
