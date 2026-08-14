# flightdeck

A terminal cockpit for the Claude Agent SDK that enforces my verification
doctrine in process instead of asking me to enforce it by hand.

## Why it exists

My doctrine used to be enforced by hooks inside the Claude Code CLI: small
Python scripts that read a JSON payload on stdin and answer with an exit code.
That mechanism has a ceiling, and I hit it twice.

A hook can only refuse. One of my standing orders routes each phase of work to
its own model, planning on one and implementation on another, and a hook cannot
change the model. So the gate stopped the work and told me to type `/model`
myself, every time. It was correct and it was the most irritating thing I owned.

The other limit was distribution. The doctrine lived in one repository and
reached each machine through an installer that copied files and verified them by
hash. Copies drift, so the installer grew a backup system, a merge system, and a
drift detector to manage problems that copying had created in the first place.

The SDK exposes `setModel()` and `setPermissionMode()` to my own code, so
enforcement stops being a wall and becomes logic that does the right thing. It
also loads `~/.claude` natively, so the doctrine, the skills, and the agent
definitions carry across unchanged.

## What it does

Entering plan mode sets plan mode and the plan model in one operation.
Approving a plan switches to the implementation model and starts that phase.
Turning a plan down leaves both where they were. Ordinary conversation requires
no particular model, so a one line fix stays a one line fix.

Subagent calls are corrected rather than refused. A permission decision can
carry modified input, so a call on the wrong tier has its model rewritten on the
way through instead of being denied and reissued.

Four guards run in process: authorship, convergence, sycophancy, and the
vagueness filter. They share one session state rather than each rebuilding the
same facts from the transcript. A guard that throws is switched off, and the
status bar says so, because something unmeasured has to look broken rather than
quietly stop happening.

The status bar shows the model I asked for and the model that actually answered.
They differ when the safety layer reroutes a session, which used to be a silent
condition and is now a visible one.

## Running it

```
npm install
npm run dev              # open the cockpit here
npm run verify           # typecheck, tests, contamination check, fault injection
```

Inside the cockpit, `/plan` enters planning, `/model` pins a model until you
clear it with `/model auto`, `/health` reports which guards are running, and
`/overlays` lists what this machine loaded. Anything else starting with a slash
is a skill or a custom command, which the engine resolves from the filesystem
itself.

## Setting up a machine

```
git clone <this repo>
npm install
npx tsx src/cli.tsx bootstrap
```

Bootstrap links rather than copies. Each skill, agent, and command in the
checkout gets its own link under `~/.claude`, so editing doctrine here is live
everywhere at once and a pull is the whole sync. Copy drift becomes impossible
instead of merely detectable, which is why verification shrinks to asking
whether the links still point where they should.

It links one entry at a time and never overwrites what it finds. A machine
collects skills from plugins, from experiments, and from other people, and the
checkout has no claim on any of them. Where a name collides and the content
differs, the machine's copy stands and bootstrap says so and moves on. That is a
finished state, not a warning to clear.

There is no flag for taking the checkout's version, and that is the point rather
than an omission. A flag would get used, and the reason a machine's copy differs
is usually written down nowhere: somebody amended it for a job this checkout has
never heard of. Anyone who does want the checkout's copy can delete their own
directory and run bootstrap again, which is a decision made in the open. The
version of this that owned the whole directory instead of one entry at a time
would have deleted a machine's skills the first time anyone ran it in earnest.

A skill the machine already has that matches the checkout is linked without
argument, including when the only difference is CRLF against LF.

Directories are linked with junctions on Windows, which need no administrator
rights. `CLAUDE.md` is copied and hashed instead, because a file symlink on
Windows does require elevation and a bootstrap that demands an elevated shell
does not get run.

Plugins cannot be linked, since the engine owns their cache and installs them
itself. What travels instead is the declaration: `doctrine/settings.portable.json`
lists the plugins and marketplaces to enable, and bootstrap merges those entries
into `~/.claude/settings.json`, adding only what is absent. A plugin the machine
switched off stays off, and one the machine has that the checkout does not stays
enabled. The engine fetches anything new on the next launch. Read
`doctrine/VENDORED.md` before adding a plugin to that file: several of the ones
listed there have not been audited yet.

Credentials never enter the repository. It carries doctrine, not identity.

## Overlays

Anything that belongs to one machine and to no repository goes in an overlay:
a manifest at `~/.flightdeck/overlays.json` naming other checkouts, whose
skills, agents, and guard configuration are merged at startup. The manifest is
never committed, so the separation is structural rather than a rule the
contamination check has to enforce after the fact.

An absent manifest means no overlays, which is the normal case on a fresh
machine.

## How it is checked

The verification layer was built before the features, and it fails the build
when a detector stays quiet.

`npm run check:agnostic` scans every tracked file for project names and absolute
home directories, because the repository it replaces leaked both. Its patterns
are assembled from fragments at run time: written as literals they would make
the file match itself, and the usual fix is to exempt the checker, which puts a
hole exactly where the check belongs.

`npm run check:faultinject` proves the detectors instead of trusting them. It
writes poisoned files, runs the real checks over them, and fails when nothing
fires. It found a hole on its first run: source code escapes backslashes, so a
Windows path in a string literal carries two separators on disk and the pattern
only allowed one. Then it switches each guard off and requires that guard's
specimens to object, because a suite that stays green against a guard that does
nothing is grading itself.

The specimen corpus came across from the Python suites before any guard was
rewritten. A guard counts only once it has been watched failing on its own
specimens.

`tests/visual.tsx` renders every screen state to stdout so the interface can be
looked at rather than inferred. Doing that caught two faults source review had
missed: the approval screen put stdin into raw mode the moment it mounted, so it
could not render outside a live session, and blank lines inside a plan collapsed,
which mangled the document a person reads before approving it.

`tests/interactive.test.tsx` drives the real cockpit with real keystrokes. Ink
takes whatever stdin and stdout you give it, so a pair of streams that report
themselves as terminals is enough to exercise the keyboard loop, the line
editor, and the approval keypress with a stand-in engine, spending nothing. It
covers typing and backspace, history recall, the slash palette, `/plan` setting
plan mode and the plan model without sending anything to the model, and the
approval screen resolving on a key.

`tests/smoke-live.ts` is the only test that opens a real session. It is run by
hand and never in CI, because it spends real usage.

## One thing that live testing changed

The guards were originally attached to the permission callback. A live session
then ran a shell command without the kernel being consulted at all, because a
permission rule already allowed the tool and the callback is skipped in that
case. Nothing caught it, because the smoke test checked that a tool call had
happened and reported that as the kernel having seen it, which is the difference
between a proxy and the thing itself.

The guards now run on `PreToolUse`, which fires for every tool call. The live
test counts what the kernel actually saw, and asks the model to write something
the authorship guard has to refuse so the refusal is observed rather than
assumed. `tests/interception.test.ts` holds the wiring in place, because guards
that are never called look exactly like guards that found nothing wrong.

## Status

Early. The pieces work and are tested, including the keyboard loop and a live
session, but it has not yet been used for a full working day, which is the bar
I set for replacing the CLI.

I also nearly left the interactive layer unchecked on the belief that it needed
a real terminal. That belief was never tested, and it was wrong.
