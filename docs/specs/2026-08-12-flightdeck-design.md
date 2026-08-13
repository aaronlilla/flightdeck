# flightdeck: design

Founding document. Written 2026-08-12, before any code.

## Why this exists

I run a verification doctrine of seventeen standing orders. Until now it has
been enforced by hooks inside the Claude Code CLI: small Python scripts that
read a JSON payload on stdin and answer with an exit code. That mechanism has
a ceiling, and I have hit it twice.

The first limit is that a hook can only refuse. Standing order 17 routes each
phase of work to its own model: planning on Fable, implementation on Opus,
research on Sonnet. A hook cannot switch the model, so the gate stops the work
and tells me to type `/model` myself. Every planning session pays that tax.
The gate is correct and it is also the most annoying thing I own.

The second limit is distribution. The doctrine lives in one repo and reaches
each machine through an installer that copies files into `~/.claude` and
verifies them by hash. Copies drift. Employer-specific hooks and absolute
paths leaked into what was supposed to be a project-agnostic setup, and the
installer grew a backup system, a merge system, and a drift detector to manage
problems that copying created in the first place.

flightdeck is the response to both. It is a terminal application built on the
Claude Agent SDK that replaces the CLI as my daily interface. The SDK exposes
the controls the hook protocol does not: `setModel()` and
`setPermissionMode()` can be called mid-session by my own code. Enforcement
stops being a wall that says no and becomes logic that does the right thing.

## What the SDK provides, and what it does not

These are verified against the current documentation rather than assumed,
because the whole design rests on them.

The SDK bundles and spawns the Claude Code binary, so it inherits the same
credential chain. With no API key present it falls through to subscription
OAuth, and billing runs against the plan rather than metered tokens. The
documentation also states that Anthropic does not permit third party
developers to offer claude.ai login for their products, including agents built
on the SDK. That sentence addresses products that log in other people. It does
not carve out personal single-user use either way. I am proceeding with both
halves of that in view.

By default the SDK loads `~/.claude` and the project `.claude` directory
exactly as the CLI does, which means CLAUDE.md, skills, agents, custom slash
commands, and filesystem hooks all come across without modification. Slash
commands and skills are executed by the engine: the application passes the
literal command text as a prompt and the engine resolves the file. Sessions
persist to disk automatically, resume works, context compaction is automatic,
and subagents are fully supported.

Six permission modes exist, including plan mode. In plan mode the engine never
auto-approves a file write regardless of allow rules. It routes every one to
the application's `canUseTool` callback instead. The engine guarantees the
decision point exists. Holding the line is the application's job.

What the engine does not provide is any interface. No rendering, no approval
prompt, no input line. That is the work flightdeck takes on. Agent teams are
the one feature that remains CLI-only and has no SDK equivalent.

## Decisions

I chose to build my own daily driver rather than soften the existing gate,
route implementation through an Opus subagent while pinning the main thread to
Fable, or drop model tiering. I chose to design the platform up front rather
than start with a thin loop and grow it, accepting a longer period before it
is usable. TypeScript over Python, despite the nine existing guards being
Python, because those guards keep working as filesystem hooks in either
language and TypeScript is my daily stack.

The half-finished work to strip employer-specific content out of the old repo
is frozen where it stands. The cost is real: that contamination stays in the
old repo and in every `~/.claude` it has installed to, including my work
machine, for as long as this build takes.

## Architecture

Five layers, plus the verification harness that watches them.

The engine adapter is the only module that imports the SDK. It wraps the
streaming query, session handling, and the control calls, and it emits typed
events upward. Everything above it sees flightdeck's own types, so an SDK API
change has a one-file blast radius.

The policy kernel is the doctrine as running code. Guards for authorship,
convergence, sycophancy, and vagueness become in-process modules sharing one
typed session state (current phase, selected model, serving model, approval
history) rather than five separate scripts each re-parsing the transcript tail
to work out the same facts. Each guard implements one interface: observe an
event, or decide on a tool call by allowing it, denying it, modifying it, or
annotating it.

The cockpit is an Ink terminal interface. It renders the conversation and owns
the approval surface.

Doctrine content is data: CLAUDE.md, skills, agent definitions, and commands
as plain files the engine loads natively. They stay editable without touching
application code.

Overlays are per-machine additions merged at startup from a manifest that is
never committed. The work machine's employer-specific material lives in one.

## Phase routing

The kernel holds a phase state machine that moves between conversation,
planning, and implementation. Research sits at the subagent level rather than
the session level.

Entering planning sets the permission mode to plan and the model to Fable in
the same operation. There is no gate and no refusal, which is the entire point
of the project. On plan approval the kernel switches to Opus and enters
implementation. On rejection the session stays in planning on Fable. The
conversation phase carries no model requirement at all, so one-line fixes and
ordinary discussion are not policed, which preserves the proportionality the
old gate achieved with a marker file.

None of this depends on whether an SDK hook callback may call `setModel()`,
which is undocumented. Every transition happens in application-owned code: the
command router and the approval surface.

Subagent routing improves on refusal. The old hook denied an Agent call whose
model did not match its tier and made the model try again. `canUseTool` can
return modified input, so the kernel rewrites the model to the correct tier and
lets the call through. The wrong call becomes impossible to execute and nobody
loses a turn.

The convergence guard annotates the plan approval screen at the point where
something is missing rather than denying the approval outright. The status bar
shows both the model I selected and the model that actually answered the last
turn, so the silent safety-layer reroute that the old gate could only document
as a known hole becomes something I can see.

## Doctrine migration

Content sorts into three groups.

CLAUDE.md, the generic skills, the vendored skills with their provenance
ledger, agent definitions, and commands move across close to verbatim. One
deliberate edit: the standing orders that describe hook mechanics name the
kernel modules that enforce them instead, because the doctrine should describe
the mechanism that exists.

The five generic guards are rewritten rather than moved. The valuable part of
their Python test suites is the specimen corpus: every deliberately broken
payload the suites fire at them. That corpus ports first. Under standing order
2 a rewritten guard counts only once it has been watched failing on its own
specimens, so no guard is considered done until it has produced a red run.

The installers and their hash verification machinery are not migrated. The
employer-specific hooks stay in the old repo and return later as overlay
content.

Nothing is copied wholesale. Content crosses file by file through a
contamination check that runs in CI from the first commit, and that check
covers absolute home directory paths such as `C:/Users/<name>`, a leak class
the old plan's pattern would have missed. The old repo keeps driving the CLI
unchanged throughout, so daily work does not wobble during the build.

## Distribution

One clone is the whole setup and git is the sync mechanism. A new machine
needs git, Node, a clone, `flightdeck bootstrap`, and a login.

Bootstrap does not copy files into `~/.claude`. It creates directory junctions
so that `~/.claude/skills`, `~/.claude/agents`, `~/.claude/commands`, and the
user CLAUDE.md point into the repository checkout. Editing doctrine in the
repo makes it live immediately, and `git pull` on another machine is the sync.
Verification shrinks to checking that the links are intact and the repo is
clean, because copy drift becomes structurally impossible instead of merely
detected. A verified-copy path remains as a fallback for any platform where
junctions fail.

Claude Code keeps working on the same content, so the CLI is a usable fallback
if flightdeck is broken. The honest limit: once the guards move in-process, a
CLI session has the doctrine text and skills but not the mechanical
enforcement.

Credentials, OAuth state, and MCP configuration never enter the repository.
The repo carries doctrine, never identity.

Overlays are listed in an uncommitted machine-local manifest at
`~/.flightdeck/overlays.json` that names overlay repository paths. At startup
the application merges each overlay's skills, guard configuration fragments,
and extra agents and commands. Overlay content never enters the main
repository, which makes the separation structural rather than a rule enforced
by a pattern match.

## The cockpit

One screen, keyboard first. A conversation stream renders markdown, collapses
tool calls to a single line that can be expanded, and shows guard output as
inline banners rather than burying it. Below that is an input line with a
slash command palette. At the bottom, a status bar carries the current phase,
the selected model, the serving model, the permission mode, the session id,
and a context meter. A mismatch between selected and serving turns that
segment red.

One approval surface handles everything the engine routes through
`canUseTool`: tool approvals with a unified diff for edits, clarifying
questions as an option picker, and plan approval as a full screen with the
rendered plan and the convergence guard's annotations placed inline. Allow
once, deny, and allow for the session are single keystrokes.

Both `/plan` and shift+tab toggle plan mode, and the resulting phase and model
transition is visible in the status bar. Commands that belong to the engine
pass through as prompt text. Commands that belong to the application are
handled before the engine sees them: a session picker for resume, a manual
model override that holds against the router until cleared, overlay
inspection, and a phase override.

Deliberately absent from the first version, so that their absence reads as a
decision rather than an oversight: editor integration, checkpoint and rewind
interface, side by side diffs, image rendering, and themes. Each is additive
later and none of them blocks daily use.

## Failure semantics

This application becomes a single point of failure for my working day, so it
is designed to be restarted rather than repaired in place.

The engine persists every session to disk, so restart and resume is the
recovery path for anything that crashes. Because those sessions live in the
same store the CLI reads, `claude --resume` on the same session is the escape
hatch of last resort. That interoperability is assumed and gets verified in
the first week rather than trusted.

A guard exception may never take down the render loop. The kernel degrades to
a persistent banner reading that enforcement is unchecked, because standing
order 1 holds that anything unmeasured reads as broken and therefore has to
look broken.

The asymmetry from the old model gate carries over. A guard failure during a
rare deliberate action such as plan approval fails closed and requires an
explicit override. A failure on a high frequency path fails open, logs, and
surfaces the log once rather than repeatedly. Kill switches exist per guard
and globally, and a disabled guard stays visible in the status bar for as long
as it is off.

## Self-verification

Standing order 10 applies to this project literally, so the verification layer
is built before the features.

The specimen corpus ports before any guard is written, and every guard is
watched failing on its specimens before its passing run counts. CI runs fault
injection from the first commit: a neutered guard has to be detected, and the
degraded banner state is asserted rather than assumed. The contamination check
runs alongside it. Both Windows and Linux legs run, because the bootstrap
logic is platform-specific where junctions are concerned.

The engine adapter is tested against recorded stream fixtures. A live session
smoke test exists but is triggered manually, because it spends real
subscription usage and spending traces to a decision. Interface states are
tested as renders: the approval modal, the plan annotations, the
selected-versus-serving mismatch, and the degraded banner.

Cutover has a definition rather than a feeling. Bootstrap green on both
machines, every guard proven against its specimens, and five consecutive full
working days inside flightdeck without falling back to the CLI. My own daily
use is the final sign-off.

## Known unknowns

The subscription authentication question is a policy reading, not a technical
one, and it is unresolved in the documentation.

Session store interoperability between the CLI and the SDK is assumed and
unverified. It gets a spike in week one.

Whether Ink is the right choice for an approval interface of this complexity
is untested.

Whether an SDK hook callback may call `setModel()` is undocumented. Nothing in
this design depends on the answer.

## What would prove this wrong

If the period before cutover pushes my daily work permanently back to Claude
Code, the decision to design the platform up front was the wrong one, and
starting from a thin loop that grows would have been right. That outcome
should trigger a rescope rather than a longer push, and the signal to watch
for is a week where I open the CLI by preference instead of by necessity.
