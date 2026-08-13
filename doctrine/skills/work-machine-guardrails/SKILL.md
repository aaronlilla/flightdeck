---
name: work-machine-guardrails
description: Standing discipline for any employer machine or repo — the never-list (secrets, force-push, prod destruction, code exfiltration), the never-migrate list for machine setup, the poka-yoke wiring that makes violations mechanical, memory hygiene, third-party vetting. Use when working on an employer's machine or in a company codebase, setting up Claude Code at a new job, migrating configuration to a work machine, evaluating a third-party skill or MCP server on employer hardware, or before any operation that could touch production.
---

# Work-machine guardrails

On a personal project a mistake costs a redo. On an employer machine a
leaked token or a dropped table is an incident with the user's name on
it. These rules bind at full strength on any employer machine or repo,
on top of the doctrine's always-on orders (4, 5, 6, 9, 11). First
session in the codebase itself: `onboard-codebase`.

## The never-list

1. **No secrets, tokens, or credentials in commits, logs, or pasted
   output — scan the full diff before every commit.** A secret that
   reaches a remote is compromised the moment it lands; rotation is a
   team-wide fire drill, and history rewrite (see next rule) is not an
   available cleanup.
2. **No force-push or history rewrite on shared branches.** It silently
   destroys teammates' work and the audit trail, and there is no
   mechanical undo.
3. **No destructive ops against anything that could be prod** — DB
   drops, bucket deletes, mass deletes — **without an explicit user
   decision** (doctrine order 9). Destruction is unrecoverable spend;
   it traces to a decision the user made, never to my theory.
4. **No company code to external services, third-party MCP servers, or
   unvetted marketplace plugins.** Every byte that leaves employer
   infrastructure is a disclosure the employer never authorized.
5. **Unsure whether a resource is prod = it IS prod.** Stop and ask
   (fail-closed): asking costs a minute, guessing wrong costs an
   incident.

## The never-migrate list

From any other machine to a work machine, these never come across:

- `~/.claude.json` — personal MCP servers and project history
- `~/.claude/.credentials.json` — personal OAuth tokens
- `history.jsonl` — prompt history
- `projects/` — session transcripts and auto-memory of personal work
- `shell-snapshots/` — captured personal shell state
- personal agents
- settings keys `skipDangerousModePermissionPrompt` and `model` —
  machine-local by design; the first is a safety removal that must
  never travel

Migration is always and only: clone dev-harness, run the installer,
log in fresh with the work account. Nothing else is a supported path.

## Poka-yoke wiring (order 7 — wire it, don't just write it)

**Already shipped.** `settings.portable.json` denies force-push
mechanically — `Bash(git push --force:*)`, `Bash(git push -f:*)` — and
makes the common secret files unreadable, and therefore unpasteable:
`Read(./.env)`, `Read(./.env.*)`, `Read(**/.env)`, `Read(**/.env.*)`,
`Read(**/secrets/**)`, `Read(**/*.pem)`, `Read(**/id_rsa*)`. The
installer merges these in. Verify mode does NOT yet check the
permissions lists (it covers managed files, plugins, and the hook
registration) — if a deny rule is removed from settings.json by hand,
nothing catches it today. Tracked as a repo issue; until it lands,
re-running the installer re-merges the rules.

**First weeks on a new job machine:** set `permissions.defaultMode` to
`"plan"`. Propose-before-build stops being a habit under momentum;
plan mode makes it mechanical until the codebase and its blast radii
are known.

**Where the team has no secret scanning:** propose a gitleaks (or
equivalent) pre-commit hook through a normal PR and let the team
decide. Never install hooks or enforcement into a shared repo
unilaterally — same rule as the registry ban in `escape-procedure`.

**What cannot be wired on day 1:** prod hostnames, secret paths, and
blast radii are employer-specific. Fill this in during week one, and
wire each answer as a deny rule or hook the day it is learned — a
checklist item that stays prose is a rule waiting to decay:

- [ ] Prod hostnames / URLs / connection-string names → deny rules or
      a hook that blocks commands containing them
- [ ] Cloud accounts, project IDs, or subscriptions that are prod →
      denied in CLI invocations
- [ ] Secret file paths beyond the stock patterns → added to the
      `Read` deny list
- [ ] Shared/protected branches → confirmed covered by the force-push
      deny and the host's branch protection
- [ ] The employer's approval process for MCP servers and plugins →
      written into the project `.claude/`
- [ ] Where CI/deploy credentials live → confirmed unreadable by the
      deny rules

## Memory and data hygiene

Auto-memory under `~/.claude/projects/<work-repo>/` accumulates
employer-confidential detail with every session — architecture, naming,
incidents, sometimes data. Those directories never sync to personal
dotfiles, personal cloud, or backup tooling that leaves the machine.
Nothing job-confidential lands in the personal doctrine repo: a lesson
worth keeping gets generalized — employer names, hostnames, and code
stripped — before it is committed.

## Third-party skills and MCP on employer hardware

A skill or MCP server is arbitrary code running with my permissions on
the employer's machine. Before installing any:

- **Read every bundled script** — install steps, hooks, binaries — not
  just the SKILL.md.
- **Record source and license** (the pattern: `VENDORED.md` at the
  dev-harness repo root).
- **Prefer official-marketplace equivalents** over personal or unvetted
  repos.
- **Follow the employer's approval process**, whatever it is — their
  hardware, their rules, even when slower.
