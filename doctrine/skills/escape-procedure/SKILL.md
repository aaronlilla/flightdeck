---
name: escape-procedure
description: When a defect reaches a human that automated checks called green (a test escape) — reproduce it as a failing specimen, prove the hole, build the detector, only then fix. Full registry drill in harness-mode projects; in ordinary team codebases it collapses to regression-test-first bugfixing. Use for any escaped defect.
---

# The escape procedure — test escapes grow the oracle

Every automated check set is an oracle, and every oracle is incomplete.
When a defect reaches a human that the checks called green — a bug
report, a production incident, the user catching what CI passed — that is
a **test escape**. Style or design preferences raised in code review are
feedback, not escapes: checks were never supposed to catch taste.

The order of operations is fixed, and fixing the artifact comes LAST.

## In an ordinary team codebase

(existing CI, code review, no fail-closed harness — the default at a job)

1. **Reproduce it as the smallest failing regression test** — one that
   differs from passing tests only in the defect dimension.
2. **Prove the hole.** Confirm the current suite passes WITHOUT the new
   test (run it; record it). A hole you cannot demonstrate is a hole you
   do not understand.
3. **Fix with the new test as referee.** Commit test + fix together; the
   PR description names, in one line, the class of gap the escape
   revealed.

Never scaffold a defect registry, coverage file, or enforcement layer
into a repo the team owns. If the escape suggests a systemic gap,
propose the check through a normal PR and let the team decide.

## In harness mode

(a project with a defect registry and fail-closed coverage enforcement —
see standing order 10 in ~/.claude/CLAUDE.md)

Translation for software people: the registry is the test suite's index,
the specimen is a minimal failing fixture, proving the hole means showing
today's checks pass the broken specimen.

1. **Stop and register.** Add the defect class to the registry
   immediately, marked uncovered/blocking, before investigating the fix.
   If coverage enforcement is fail-closed, everything now fails — that
   is intended.
2. **Reproduce it as a specimen.** The smallest artifact (fixture, test
   case, seeded fault) exhibiting exactly this defect and nothing else.
3. **Prove the hole.** Run the CURRENT checks against the specimen and
   record that they pass it. This step is evidence, not ceremony.
4. **Build the detector.** Extend or add a check until the specimen
   fails for exactly the intended reason, known-good specimens still
   pass, and the detector's output reaches whatever summary humans read.
   Thresholds seed from measured values.
5. **Only now fix the artifact,** with the new detector as referee. The
   fix is proven when the escaped defect goes from a failing number to a
   passing one — and, for anything human-visible, when the human
   confirms in the shipping environment.

Never skip proving the hole. Never fix before the detector exists — a
fix that lands first is unverifiable and the defect class returns
silently. Post-fix, record the escape: what escaped, which layer missed
it and why, and the numbers.
