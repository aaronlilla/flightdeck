---
name: onboard-codebase
description: First session in any repo not yet mapped — a new job's codebase, an unfamiliar open-source project, any repo whose project CLAUDE.md is missing or stale. Recon the stack from manifests, RUN the real build/test/lint/typecheck commands and record actual pass/fail, read CI as the team's oracle, mine norms from git evidence, write the map into the project's .claude/CLAUDE.md. Use before writing any code in an unfamiliar repo, or when asked to onboard, orient, or map a codebase.
---

# Onboarding a codebase — the first-session discipline

An unmapped repo is unmeasured, and unmeasured reads as unknown — never
as fine. The map comes before the first line of code; one recon session
pays for every session after it. This is the highest-leverage day one
there is.

Ground rules for the whole session: evidence-gathering only — reads plus
the team's own commands. No fixes, no refactors, and never scaffold a
harness, registry, or enforcement layer uninvited (standing order 10:
an established codebase means joining ITS harness). Any command that
deploys, provisions, migrates, or costs money is recorded, not run
(order 9).

## 1. Recon — what is this?

- Stack from lockfiles and manifests, never from vibes: `package.json`
  (note the lockfile flavor — npm/yarn/pnpm/bun), `pyproject.toml`,
  `go.mod`, `Cargo.toml`, `*.csproj`/`*.sln`, `Gemfile`,
  `docker-compose*`, `Dockerfile`.
- Monorepo layout: `turbo.json`, `nx.json`, `pnpm-workspace.yaml`,
  workspaces — which packages are apps, which are libraries.
- Entry points: where execution starts (`main`/`exports`, `cmd/`,
  `Program.cs`, `manage.py`, framework conventions).
- Pinned runtimes: `.nvmrc`, `.tool-versions`, `engines`, Dockerfile
  `FROM` lines.

## 2. Commands — find them, then RUN them

Sources, in order: package scripts / `Makefile` / `justfile` /
`Taskfile`, CI config, CONTRIBUTING/README. Then actually run test,
build, lint, typecheck, and (if cheap) the dev server.

- Record ACTUAL results: exact command, exit status, duration, failure
  counts. A command not run is **UNKNOWN** — never "should work," never
  inferred from a CI badge.
- A red baseline is a finding, not a blocker: record it now so
  pre-existing failures are never later mistaken for damage you caused
  (order 8 — pre-existing noise, noted once).
- Needs credentials, services, or spend you don't have? UNKNOWN, with
  the reason. That entry doubles as a danger-zone candidate.

## 3. CI — the team's oracle

`.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`,
`azure-pipelines.yml`. This is what the team actually gates on — the
harness you are joining.

- List every gate: what runs on PR, on merge, on release, and what each
  job executes.
- List what nothing gates — no e2e? no typecheck on PRs? migrations
  untested? Per `present-results` rule 4, coverage state is part of
  every verdict; this uncovered list is what your own look must cover.
- Where local scripts and CI disagree, CI's version is the one to
  record.

## 4. Norms — from evidence, never habit

- Commit format: `git log --oneline -30`.
- Branch naming: `git branch -r`.
- PR style: last ~10 merged PRs (`gh pr list --state merged`) —
  description shape, review conventions, who approves what.
- `CODEOWNERS`, CONTRIBUTING, PR template: read them all.

Habits from the previous repo are not norms here. When written docs and
recent merged evidence conflict, evidence wins — note the conflict.

## 5. Write it into the repo

Findings land in the project's `.claude/CLAUDE.md` — committed if the
team versions `.claude/`, otherwise `CLAUDE.local.md` until you've
asked. Machine-local memory alone does not count; the map must survive
the machine.

Gaps worth closing (a missing check, a flaky suite) are proposed
through normal channels — a PR, a conversation — never installed
unilaterally. When a defect later escapes, `escape-procedure` says how
checks get added.

## 6. Cut the friction

Finish by running the built-in `fewer-permission-prompts` skill to
allowlist this repo's routine read-only commands.

## Output template

The project CLAUDE.md this session produces:

```markdown
# <repo> — project map (onboarded YYYY-MM-DD)

## Stack
runtime + pinned versions, package manager, frameworks, monorepo layout

## Commands (verified)
| command | purpose | result | date |
result is PASS / FAIL(n, pre-existing) / UNKNOWN(reason) — nothing else

## CI gates + gaps
what runs on PR / merge / release; then the uncovered list

## Norms
commits, branches, PR style, owners — each line cites its evidence

## Danger zones
migrations, deploy/release scripts, codegen, anything destructive,
credentialed, or costly — and what never to run casually
```

Every entry carries its evidence (a command run, a file, a PR number).
An entry with no evidence does not go in the map.
