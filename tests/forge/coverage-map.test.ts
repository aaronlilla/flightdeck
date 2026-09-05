/**
 * P4.7/I6: the completeness critic.
 *
 * One row per requirement line in the four stream briefs' Requirements sections, plus
 * one row per item in the spec's Section 8 (testing and proof), each naming a specimen
 * that covers it. Every named specimen is checked against the real suite -- a row that
 * points at a title nobody wrote fails here rather than being taken on faith.
 *
 * A row may instead be marked `uncovered: true` with a reason, which is what the brief's
 * "listing the uncovered ones ... rather than hiding them" asks for; an uncovered row is
 * never given a fabricated specimen name to make the table look fuller than it is.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTS_ROOT = HERE; // tests/forge

/** Every `describe(...)`/`it(...)` title string found under `tests/forge/**`, this file
 *  excluded (scanning its own literal title strings back at itself proves nothing). */
function collectTitles(): Set<string> {
  const titles = new Set<string>();
  const selfPath = fileURLToPath(import.meta.url);

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || full === selfPath) continue;
      const text = readFileSync(full, 'utf8');
      // Matches it('...') / describe('...') / it("...") with either quote style, and
      // it.each/describe.each's own leading call form. Deliberately simple (no template
      // literals) -- every specimen this file references is a plain quoted string, which
      // matches how titles are actually written across this suite.
      const pattern = /\b(?:it|describe)(?:\.\w+)?\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text))) {
        // Un-escape the same way the JS source itself would at parse time (`\'` -> `'`,
        // `\"` -> `"`, `\\` -> `\`), so a specimen written with an escaped apostrophe
        // matches a fragment quoted here without one.
        titles.add(match[2]!.replace(/\\(.)/g, '$1'));
      }
    }
  }
  walk(TESTS_ROOT);
  return titles;
}

const TITLES = collectTitles();

/** True when some collected title contains `fragment` as a substring. Substring rather
 *  than exact match: quoting and punctuation vary slightly across specimens quoted in
 *  the four briefs' own Status sections versus the literal source, and a coverage map
 *  should not be brittle to that. */
function covered(fragment: string): boolean {
  for (const title of TITLES) {
    if (title.includes(fragment)) return true;
  }
  return false;
}

interface Row {
  stream: 'warden' | 'governor' | 'intake' | 'council' | 'integration' | 'spec-section-8';
  requirement: string;
  specimen?: string;
  uncovered?: string;
}

const ROWS: Row[] = [
  // ---- Warden (brief Requirements, 9 bullets) ----
  { stream: 'warden', requirement: 'Park, nudge, kill with evidence and Aaron\'s decision id', specimen: 'a decisionId naming a different run is refused' },
  { stream: 'warden', requirement: 'Drift check on Haiku', specimen: 'parks the run and journals warden.parked with both verdicts verbatim' },
  { stream: 'warden', requirement: 'Blocker keys', specimen: 'all park, but only one blocker.raised event fires' },
  { stream: 'warden', requirement: 'Credential horizon with single-flight browser login', specimen: 'parks behind the first rather than starting its own flow' },
  { stream: 'warden', requirement: 'Cost-shape health', specimen: 'trips when context, cache-read ratio and turns-without-write all cross their thresholds' },
  { stream: 'warden', requirement: 'Single-flight credential recovery is Warden\'s, EAS coalescing is Governor\'s', uncovered: 'satisfied by omission per the Warden Status -- nothing EAS-shaped was built there to test' },
  { stream: 'warden', requirement: 'Build on liveness.ts, not beside it', specimen: 'reports only the fleet-unknown trip, never a run-keyed signal' },
  { stream: 'warden', requirement: 'Never park nothing', specimen: 'denies the very next tool call, not merely a journal row' },
  { stream: 'warden', requirement: 'fleet-unknown reported, never acted on', specimen: 'takes no actuator parameter at all: the falsifier this closes is a caller wiring a park into it' },

  // ---- Governor (brief Requirements, 7 bullets) ----
  { stream: 'governor', requirement: 'Provider at planning time', specimen: 'reads a plan-class ticket as codex and an implement-class ticket as claude' },
  { stream: 'governor', requirement: 'Burn ledger from modelUsage', specimen: 'sums a result.usage row per run, per class and per model id' },
  { stream: 'governor', requirement: 'Window pause with reset time', specimen: 'pauses every queued run of that tier and never admits one before the reset time' },
  { stream: 'governor', requirement: 'Conformance per turn', specimen: 'parks the run in the very turn a mismatch is seen, never after N turns' },
  { stream: 'governor', requirement: 'Never escalate by retry', specimen: 'assigns the same class to a run that has failed three times as to one that has not' },
  { stream: 'governor', requirement: 'EAS build coalescing', specimen: 'merges two requests for the same head, platform and fingerprint into one build' },
  { stream: 'governor', requirement: 'Budget caps', specimen: 'parks a run before it starts when it would cross its class ceiling' },

  // ---- Intake (brief Requirements, 12 bullets) ----
  { stream: 'intake', requirement: 'Watermark semantics', specimen: 'handles out-of-order delivery within a page — not merely a gap-free fixed order' },
  { stream: 'intake', requirement: 'Packets, bounded, never re-derived', specimen: 'refuses a second write for a ticket that already has a packet — nobody re-derives one' },
  { stream: 'intake', requirement: 'ExternalWrite, reconcile before retry', specimen: 'an `unknown` write is retried ONLY after reconciliation confirms the call never landed' },
  { stream: 'intake', requirement: 'Jira projection in Aaron\'s voice, self-write suppressed', specimen: 'refuses a comment carrying third-person Aaron phrasing before it ever reaches the sink' },
  { stream: 'intake', requirement: 'Active-ticket scope', specimen: 'a ticket assigned to the owner runs hands off' },
  { stream: 'intake', requirement: 'Planning provider, astra gated off', specimen: 'reasoner.astra is "off" in the real, checked-in policy file' },
  { stream: 'intake', requirement: 'Poll sources', specimen: 'covers every named poll source' },
  { stream: 'intake', requirement: 'source.observed, idempotent across restart/second reader', specimen: 'a restart that replays the same fetch against the advanced watermark emits nothing new' },
  { stream: 'intake', requirement: 'Backend stops at draft PR, frontend runs to merge', specimen: 'a backend-repo ticket ends at draft PR open with the backend owner pinged, never merge' },
  { stream: 'intake', requirement: 'Haiping\'s QA fail reopens the run, BBZ transition ids on record', specimen: 'a QA fail clears the packet, transitions back to In Progress, and files the reviewer\'s words as new evidence' },
  { stream: 'intake', requirement: 'Governor/Warden boundary (F23/F24) deferred, not solved here', specimen: 'no file under src/forge/intake defines a coalescing or credential-recovery function' },
  { stream: 'intake', requirement: 'Zero-spend, built off the contracts file', specimen: 'src/forge/intake carries no real Jira/Sentry/CloudWatch/Codex client' },

  // ---- Council (brief Requirements, 19 items per the Council Status's own enumeration) ----
  { stream: 'council', requirement: 'Attestation bound to head/base sha', specimen: 'falsifier 7: a moved head is never mistaken for the old verdict' },
  { stream: 'council', requirement: 'Typed handoffs, incomplete fails the gate', specimen: 'a Haiping handoff missing perPlatform fails the gate and names the field' },
  { stream: 'council', requirement: 'Gitflow rule ported, proven, in-process', specimen: 'gitflow rule' },
  { stream: 'council', requirement: 'Authorship rule fires inside Council\'s own flow', specimen: 'authorship rule' },
  { stream: 'council', requirement: 'Humanizer rule', specimen: 'humanizer rule' },
  { stream: 'council', requirement: 'Sycophancy / vagueness rules', specimen: 'sycophancy rule' },
  { stream: 'council', requirement: 'Convergence out of scope', uncovered: 'deliberately untouched per Council decision 3 -- convergence stays its own kernel guard, nothing in this stream references it' },
  { stream: 'council', requirement: 'Three lenses scaled to diff risk', specimen: 'a medium diff gets three lenses' },
  { stream: 'council', requirement: 'Codex lane, read-only, contested not dropped', specimen: 'a Codex-only finding with no matching Sonnet finding is carried as contested' },
  { stream: 'council', requirement: 'Judge reads packets only', specimen: 'never carries the raw diff text' },
  { stream: 'council', requirement: 'Three fix rounds then park', specimen: 'three consecutive FIX FIRST verdicts produce exactly one park event with the packet attached' },
  { stream: 'council', requirement: 'Judge/Codex disagreement resolves without Fable', specimen: 'judge PASS, Codex FIX FIRST: disagreement, FIX FIRST wins' },
  { stream: 'council', requirement: 'RN merge gate refuses a stale check run', specimen: 'blocks merge when the check-run head sha does not match the current head, even though conclusion is success' },
  { stream: 'council', requirement: 'Backend gate never merges', specimen: 'every gate condition green still ends at draft-PR-plus-ping, never a merge call' },
  { stream: 'council', requirement: 'Squash merge never inherits GitHub\'s default', specimen: 'a ten-commit branch still produces an explicit subject and a short body' },
  { stream: 'council', requirement: 'Reconciliation-before-retry on the merge write', specimen: 'reconciles to unknown when gh pr view is inconclusive, never straight to complete' },
  { stream: 'council', requirement: 'Redact every packet, journal row, PR body', specimen: 'redacts a secret out of a PR body' },
  { stream: 'council', requirement: 'Open question #1: the rules module is wired in for real (P4.7\'s own commit)', specimen: 'denies a git push to main in a controlled repo, with the gitflow reason, and journals rule.denied' },
  { stream: 'council', requirement: 'Open question #6: no Fable call anywhere in reconciliation', specimen: 'no Codex lane ran: the judge alone decides' },

  // ---- This integration's own wiring (I2-I5), so the table covers what P4.7 itself built ----
  { stream: 'integration', requirement: 'I2: WardenTick calls reportFleetHealth/assessCostShape/actuator.park on the forge up cadence, guarded', specimen: 'parks a stuck run exactly once across three ticks, never kills, and survives a throw in reportFleetHealth' },
  { stream: 'integration', requirement: 'I2: CredentialHorizon consulted before every forge run launch', specimen: 'refuses to launch a second run on an account whose login flow is already in flight' },
  { stream: 'integration', requirement: 'I3: checkBudget at admission', specimen: 'refuses to launch when today\'s burn is already at or over the daily cap' },
  { stream: 'integration', requirement: 'I3: checkConformance per turn, parking through the Warden actuator', specimen: 'parks the run in the very turn a served model does not match its class, through the Warden actuator' },
  { stream: 'integration', requirement: 'I3: WindowGate pauses on a rate-limit engine.error, with a resolved resumeAt', specimen: 'journals run.paused with the resolved resumeAt, for a rate-limit-shaped error' },
  { stream: 'integration', requirement: 'I3: providerFor delegates to policy.ts instead of a second hardcoded map', specimen: 'agrees with policy.ts\'s own providerFor for every declared class' },
  { stream: 'integration', requirement: 'I4: the rules library runs on the worker\'s PreToolUse hook, not only inside Council\'s own gate', specimen: 'denies a git push to main in a controlled repo, with the gitflow reason, and journals rule.denied' },
  { stream: 'integration', requirement: 'I5: forge intake --once journals source.observed, packet.written, external.intent', specimen: 'with fixture feeds injected, journals source.observed, packet.written and external.intent' },

  // ---- Spec Section 8 ("Testing and proof") ----
  { stream: 'spec-section-8', requirement: 'Zero-spend: ceiling -> handoff', specimen: 'the context ceiling' },
  { stream: 'spec-section-8', requirement: 'Zero-spend: class never escalates', specimen: 'assigns the same class to a run that has failed three times as to one that has not' },
  { stream: 'spec-section-8', requirement: 'Zero-spend: warden parks on idle/drift/blocker', specimen: 'parks the run and journals warden.parked with both verdicts verbatim' },
  { stream: 'spec-section-8', requirement: 'Zero-spend: blocker propagation', specimen: 'clearing the key resumes all three in the order they arrived' },
  { stream: 'spec-section-8', requirement: 'Zero-spend: breaker', specimen: 'the zero-turn breaker' },
  { stream: 'spec-section-8', requirement: 'Zero-spend: intent/complete never double-posts', specimen: 'an `unknown` write whose call DID land is marked complete without a second write' },
  { stream: 'spec-section-8', requirement: 'Zero-spend: replay after a torn journal', specimen: 'keeps every whole line before the torn one and counts the loss' },
  { stream: 'spec-section-8', requirement: 'Zero-spend: router fixtures', uncovered: 'the console (cut 2) has not merged into this branch yet -- its own router fixtures are that stream\'s evidence, not this integration\'s' },
  { stream: 'spec-section-8', requirement: 'Zero-spend: lane-record shape validated against today\'s real files', specimen: 'LaneRecordSchema' },
  { stream: 'spec-section-8', requirement: 'Live proofs: smoke goal with a forced handoff', uncovered: 'a live proof against a real process; the guardrails forbid a live SDK session or process in any test here, and no such proof was run' },
  { stream: 'spec-section-8', requirement: 'Live proofs: one RN ticket to autonomous merge behind the full gate', uncovered: 'a live end-to-end proof against real GitHub/Jira state; not attempted by this integration' },
  { stream: 'spec-section-8', requirement: 'Live proofs: one backend ticket to a draft PR with Joe pinged', uncovered: 'a live end-to-end proof; not attempted by this integration' },
  { stream: 'spec-section-8', requirement: 'Live proofs: one Sentry issue to a ticket with a packet', uncovered: 'a live end-to-end proof against a real Sentry project; not attempted by this integration' },
  { stream: 'spec-section-8', requirement: 'Live proofs: kill-and-forge up resuming every run with no duplicate comment', uncovered: 'a live multi-process proof; Warden\'s own Status names the same gap (no integration test starts an actual forge run process)' },
  { stream: 'spec-section-8', requirement: 'Console: screens checked at desktop and half width, looked at by Aaron', uncovered: 'a human visual check, not a specimen this suite can run' },
  { stream: 'spec-section-8', requirement: 'Cost replay of the 2026-09-03 window under the policy, old vs new in the PR body', uncovered: 'no cost-replay tool exists in this repo yet; not built by this integration' },
];

describe('P4.7/I6: coverage map', () => {
  it('every row naming a specimen points at a title that actually exists in the suite', () => {
    const missing = ROWS.filter((row) => row.specimen !== undefined && !covered(row.specimen));
    expect(missing).toEqual([]);
  });

  it('every row is either covered by a real specimen or explicitly marked uncovered -- never both, never neither', () => {
    for (const row of ROWS) {
      const hasSpecimen = row.specimen !== undefined;
      const hasUncovered = row.uncovered !== undefined;
      expect(hasSpecimen !== hasUncovered).toBe(true);
    }
  });

  it('the scanner actually found titles (a falsifier for the scanner itself: an empty result would make every "missing" check above vacuously pass)', () => {
    expect(TITLES.size).toBeGreaterThan(500);
  });

  it('lists every uncovered row, for the Status to quote verbatim', () => {
    const uncovered = ROWS.filter((row) => row.uncovered !== undefined)
      .map((row) => `${row.stream}: ${row.requirement} -- ${row.uncovered}`);
    expect(uncovered.length).toBeGreaterThan(0);
    console.info(`P4.7/I6 uncovered (${uncovered.length}):\n${uncovered.map((l) => `  - ${l}`).join('\n')}`);
  });
});
