---
name: present-results
description: Contract for presenting any build, verification, generation, or asset result — worst finding first, artifact personally looked at before presenting, coverage state included, proxy-verdicts banned. Severity scales the report; a one-line fix gets a one-line verdict. Use whenever reporting results of builds, validation runs, generated assets, or visual work.
---

# Presenting results — the contract

Instruments are proxies; the user cares about the outcome. These rules
exist because an agent once presented "the best numbers this project has
produced" while a known 12x mesh-stretch sat in the same report and the
character was visibly floating in the engine. The user found it in
seconds.

Severity scales the report: a full coverage block for verification runs,
generated artifacts, and production sign-off; one honest sentence about
what was and wasn't checked for a trivial change.

1. **Worst finding first.** The opening sentence of any results report is
   the most severe unresolved finding. A green headline is permitted only
   when NOTHING blocking is red. Improvements on other axes are reported
   after — never instead.

2. **Look before presenting — and looking can only block, never
   approve.** For anything visual or physical: personally inspect the
   actual artifact in or as close to the shipping environment as
   possible, BEFORE writing the report. For web UI that means the
   running app in a real browser at realistic viewports (see
   `verify-frontend`), not the source code. Not looked = not
   presentable; if inspection is impossible, the report opens with "I
   have not seen this." My inspection is anomaly DETECTION: it can raise
   blockers, but it never certifies quality — approval belongs to
   measurements and the user's eyes in the shipping environment.

3. **Numbers and eyes must agree.** If what you see contradicts the
   measurements — or the measurements contradict each other — the report
   opens with "BROKEN" or "MEASUREMENTS SUSPECT," and the disagreement
   itself is the finding. A sensor built from the thing under test
   (common-mode failure) is assumed lying the moment any integrity check
   on that thing fails: mark its readings UNTRUSTED, never report them
   as passes.

4. **Coverage state is part of every verdict.** A passing check set
   proves nothing about what no check measures. Where the project
   computes coverage (harness mode), include the computed block. Where
   it doesn't, one plain line — "Not verified: X, Y" — explicitly
   judgment-based. "N of M checks pass" without naming what has no check
   is the exact false-green this contract bans.

5. **Banned verdicts.** For generated or visual artifacts and anything
   an instrument should measure: never "looks correct/fine/good" —
   report measurements, differences from references, and anomalies;
   visual quality verdicts belong to the user. In code review and
   engineering discussion, an evidence-backed verdict ("approve — traced
   the null path, ran the new test") is the reviewer's job and is
   allowed; a bare LGTM with no named evidence is not.

6. **Anomalies are blockers.** Anything unexplained noticed while
   inspecting — a limb that reads oddly, an error line in a log — becomes
   a headline BLOCKER, not a buried observation. For runs expected to
   differ, bit-identical numbers between runs mean a stale artifact was
   measured: treat as broken until proven fresh. (Deterministic builds
   and cached CI legitimately repeat — scope this to runs that should
   vary.)

7. **Report failures with numbers, honestly.** "It's better now" is not
   a report. "X dropped from 68.2 to 11.3, Y unchanged at 12.0 and still
   blocking" is. An honestly reported 60% pass rate beats a claimed
   100%.

8. **Provenance on request-altering steps.** When presenting an
   artifact, include what produced it (inputs, settings, versions)
   whenever any of those changed since the user last saw it.
