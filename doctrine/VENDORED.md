# Vendored third-party skills — provenance and modifications

Rule (see `work-machine-guardrails`): a vendored skill is arbitrary code
running with your permissions — record where it came from, under what
license, and every local change. UNKNOWN below means exactly that:
unrecorded at vendoring time, not fine. Fill unknowns in before pulling
any update from upstream.

Location note: this file lives at the repo root, not in `skills/`,
because the installers manage `skills/` as skill directories only — a
loose file there fails install.sh's post-copy verification. Do not move
it into `skills/` without teaching both installers about it first.

## ui-ux-pro-max

- **Source:** github.com/nextlevelbuilder/ui-ux-pro-max-skill (community
  project, no Anthropic affiliation) — identified during the 2026-07-28
  audit by matching its published data counts (84/192/74/22) against
  this tree exactly.
- **License:** UNVERIFIED — no license file in the vendored tree; check
  the upstream repo before redistributing. Treat as all-rights-reserved
  until resolved. **2026-08-02 decision:** installs as-is on the work
  machine as personal tooling; owner accepts the license ambiguity for
  private, non-redistributive use. Never redistribute, vendor into an
  employer repo, or publish until the upstream license is resolved.
- **Local modifications (2026-07-28):**
  - Precedence section added: the `frontend-design` plugin leads
    aesthetic direction; this skill is scoped to UX/accessibility/
    platform-idiom review, stack idioms, and reference data; canned
    palettes and pairings are options, never defaults.
  - Frontmatter description rewritten as trigger conditions; data counts
    corrected against the CSVs (84 styles, 192 palettes, 74 font
    pairings, 25 charts, 99 UX guidelines, 22 stacks).
  - Stack table rebuilt from `scripts/core.py` STACK_CONFIG.
  - All CJK/fullwidth text translated to English; hardcoded React Native
    stack assumption replaced with manifest detection.
  - Icons unified on lucide-react default (Phosphor / Heroicons as
    alternatives); broken icon path fixed to `data/icons.csv`.
  - `data/draft.csv` deleted (1778 lines, unreferenced).
  - Thumb Zone & Reachability rules added; Cupertino rows added to
    `data/stacks/flutter.csv`, Native Feel rows to `swiftui.csv`,
    Material 3 rows to `jetpack-compose.csv`.
  - `references/ios-hig-patterns.md` and
    `references/material3-patterns.md` added (decision tables).
  - `data/design.csv` deleted (1776 lines, referenced by nothing): its
    mobile-native aesthetic direction extracted and translated into
    `references/native-feel-aesthetics.md`; its 17 per-style blocks
    dropped as 1:1 duplicates of `data/styles.csv` rows.

## ui-styling

- **Source:** claudekit (per SKILL.md frontmatter metadata); upstream
  URL not recorded.
- **License:** CONFLICTING RECORDS — frontmatter says MIT, but the
  bundled `LICENSE.txt` is stock Apache-2.0 with no copyright holder
  filled in. Resolve against upstream before any redistribution.
  **2026-08-02 decision:** same work-machine terms as ui-ux-pro-max
  above.
- **Local modifications (2026-07-28):**
  - `references/shadcn-theming.md` rewritten for shadcn/ui + Tailwind v4
    (oklch values, `@theme inline`, `@custom-variant dark`); the v3
    recipe kept as a clearly labeled legacy appendix.
  - `scripts/` deleted entirely (shadcn_add.py, tailwind_config_gen.py,
    tests, coverage); SKILL.md references removed.
  - Token-authority note added to SKILL.md: the shadcn CSS-variable
    convention is the only token convention in shadcn projects.
  - `references/tailwind-customization.md`: config-file sections labeled
    Tailwind v3 legacy with v4 equivalents named; v4 snippet errors
    fixed (`--text-*` font-size namespace, `--value()` in functional
    utilities).

## stop-slop

- **Source:** github.com/hardikpandya/stop-slop, vendored 2026-08-02 at
  upstream commit `8da1f03`.
- **License:** MIT, copyright (c) 2025 Hardik Pandya — `LICENSE` vendored
  verbatim alongside the skill. First vendored skill with no license
  ambiguity; redistribution in this repo is compliant with attribution.
- **What it is:** prose de-slopping — removes AI writing tells (throat-
  clearing, binary contrasts, adverb crutches, false agency) with a
  5-dimension scoring rubric. Pure markdown, zero executable code
  (verified file-by-file at vendoring time).
- **Local modifications:** none. Upstream `README.md` and `CHANGELOG.md`
  were not vendored (repo docs, not skill payload).

## humanizer

- **Source:** github.com/blader/humanizer, vendored 2026-08-12 at
  upstream commit `523374d`. Standing order 14 names this skill and the
  authorship guard demands it, but until this date nothing shipped it —
  the order pointed at a component no installer carried.
- **License:** MIT, copyright (c) 2025 Siqi Chen — `LICENSE` vendored
  verbatim alongside the skill. No ambiguity; redistribution in this
  repo is compliant with attribution.
- **What it is:** removes the tells of AI writing catalogued by
  Wikipedia's "Signs of AI writing" guide (WikiProject AI Cleanup) —
  33 numbered patterns with before/after examples, false-positive
  guidance, and pasted/file/embedded invocation modes. Pure markdown,
  zero executable code (verified file-by-file at vendoring time; the
  upstream repo's one script is a local metadata validator, not skill
  payload).
- **Local modifications:** the `LOCAL AMENDMENT v1` block is appended to
  the end of `SKILL.md` between HTML comment markers. Rules A through F:
  authorship, mandatory surfaces, exclusions, precedence over
  `stop-slop`, no fact drift, and composition with `i-have-adhd`.
  Everything between the frontmatter and the amendment marker is
  upstream verbatim. The frontmatter `description` is rewritten as well:
  upstream's is passive ("Use when editing or reviewing text"), and a
  passive description is why the skill never fires unless it is asked
  for by name. The replacement names the outward-facing surfaces and the
  authorship rule so the model reaches for it on its own. `metadata`
  carries `upstream` and `local_amendment`.
- **The 2026-08-12 vendoring lost both of those** and nobody noticed
  until 2026-08-13, because the copy still looked like a humanizer. It
  was re-cut from raw upstream, so the checkout shipped a skill that
  would not fire on its own and carried no authorship policy, while
  orders 13 and 14 named it as the thing enforcing exactly that. Restored
  2026-08-13 from the working copy on Aaron's machine. Vendor from a
  machine that has the amendment, never from upstream directly, unless
  you are re-applying the amendment by hand afterwards.
- **The copy here is the project-agnostic one.** Rules C and E on Aaron's
  machine name paths and units belonging to one employer's codebase, and
  `npm run check:agnostic` rejects those in this repository, correctly:
  the checkout has to be usable on a machine that has never heard of that
  project. The two
  passages are generalized here and say the same thing without the
  example. A machine is free to carry a project-specific variant, and
  bootstrap will never overwrite it or reconcile it with this one, so
  expect `humanizer` to report as kept rather than linked on any machine
  that has amended it locally. That is the intended end state, not drift
  waiting to be resolved.
- **Upstream `README.md`, `AGENTS.md`, `.claude-plugin/` manifests,
  `agents/openai.yaml` and `scripts/validate-package.py` are not
  vendored** (packaging and repo docs, not skill payload, same rule as
  stop-slop). `LICENSE` is.
- **Precedence:** per CLAUDE.md order 14, `humanizer` outranks
  `stop-slop` where they conflict; both are installed.

## sentry-cli

- **Source:** ships with the Sentry MCP/CLI tooling and was installed on
  Aaron's machine rather than fetched from a named repository; vendored
  into the checkout 2026-08-13 from `~/.claude/skills/sentry-cli` so it
  survives to the next machine. Frontmatter declares `version: 0.42.2`.
- **License:** UNKNOWN. No LICENSE file upstream or in the vendored
  tree, and the origin repository is unrecorded. Treat as
  all-rights-reserved: fine as personal tooling on our own machines,
  never redistribute or vendor into an employer repo until resolved.
  Same posture as ui-ux-pro-max.
- **What it is:** 35 markdown files, one guide plus 34 command
  references, describing how to drive the `sentry` binary. Zero
  executable code (verified: no non-markdown file in the tree). It
  documents commands that talk to Sentry and can spend nothing on its
  own.
- **Local modifications:** none. Vendored verbatim.

## Marketplace plugins — vetting record (not vendored)

Plugins enabled through `settings.portable.json` are not copied into this
repo, but the same rule applies before enabling one: read what it
executes, record the verdict here.

### impeccable (`impeccable@impeccable`, marketplace `pbakaus/impeccable`)

- **Source:** github.com/pbakaus/impeccable — Paul Bakaus. Apache-2.0
  (LICENSE verified verbatim). Plugin v4.0.4, audited 2026-08-02 at
  upstream commit `33b9a37`.
- **What it is:** design fluency — 1 skill, 23 `/impeccable` commands,
  ~60 deterministic anti-pattern detectors, live browser iteration.
- **Executable surface audited** (file-by-file greps + reads of every
  network/subprocess/credential site, 106 scripts):
  - Registers two default-on hooks: PostToolUse on Edit/Write (5 s cap)
    and Stop (30 s cap) running `hook.mjs`. **The hook path is fully
    offline** — its import graph (`hook-lib.mjs`, `loadContext`,
    `extractPlatform`) touches only local files.
  - Network exists only in explicit command paths: a once-daily version
    poll (`GET impeccable.style/api/version`, opt-out
    `IMPECCABLE_NO_UPDATE_CHECK=1`), a concept-roll fetch (design
    parameters only, local fallback), and an anonymous choice ping
    (opt-out `IMPECCABLE_NO_TELEMETRY` / `DO_NOT_TRACK`). **No file
    contents or code are transmitted anywhere.**
  - `generate-image.mjs` spends money only if `OPENAI_API_KEY` is set;
    it is not set on any machine of ours, so no autonomous spend
    (order 9).
  - Live mode binds `127.0.0.1` only, with host-parsed origin checks.
- **Poka-yoke applied:** `settings.portable.json` ships
  `env.IMPECCABLE_NO_TELEMETRY = "1"` so telemetry is off mechanically,
  not by memo. The update poll is left on (freshness has security value).
- **Prerequisite:** the design hook needs Node 22+; without it the plugin
  degrades to a one-time notice, never a silent failure.

### Enabled but not yet vetted

`doctrine/settings.portable.json` turns these on and no one has read what
they execute. The rule at the top of this section applies to each, so
until an entry exists here they are enabled on trust, which is the state
this file exists to prevent. Bootstrap only writes the declaration; it
does not audit anything.

| Plugin | Marketplace |
|---|---|
| `superpowers@claude-plugins-official` | `anthropics/claude-plugins-official` |
| `gsap-skills@gsap-skills` | `greensock/gsap-skills` |
| `i-have-adhd@i-have-adhd` | `ayghri/i-have-adhd` |
| `frontend-design@claude-plugins-official` | `anthropics/claude-plugins-official` |
| `typescript-lsp@claude-plugins-official` | `anthropics/claude-plugins-official` |
| `csharp-lsp@claude-plugins-official` | `anthropics/claude-plugins-official` |

`superpowers` is the one to read first. It carries the most skills, and
its `using-superpowers` skill instructs every session to invoke skills
before answering, so it shapes behavior on turns that have nothing to do
with it. Note also that the enabled copy comes from Anthropic's official
marketplace while `superpowers-marketplace` (`obra/superpowers-marketplace`)
is registered separately; the two can drift, and the version that installs
is whichever marketplace the plugin name resolves against.

## Adding a vendored skill

Read every bundled script first (`work-machine-guardrails`), then add an
entry here in the same shape — source, license, modifications — in the
same commit that vendors the code.
