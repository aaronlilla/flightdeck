/**
 * The self-iteration stream's own oracle: pure `analyze(inputs): SelfFinding[]`.
 *
 * Nothing here reads a file, calls a model, or touches `~/.forge`. Every input this
 * module needs is handed to it, the same seam `chain.ts` keeps from `chain-wire.ts`, so a
 * specimen can build a deliberately broken fleet in memory and watch the right finding
 * come out with no journal, no queue, and no attestation on disk.
 *
 * Six finding kinds, each named in the roadmap: `gotcha-fix-lane` (a gotcha already
 * classified into the fix lane by `gotcha.ts`), `tick-error-repeat` (the same
 * `queue.tick-error` message three or more times in 24 hours), `coverage-miss-repeat`
 * (the same council member missing from two or more rounds), `token-outlier` (a run over
 * 3x the median for its own class), `health-repeat` (the same `warden.health` signal
 * three or more times), and `repeated-work` (the same tool-call shape, or the same
 * gotcha, or the same park reason, recurring across two or more runs from different
 * tickets or sessions -- F.6's own signal for "author a routine").
 *
 * Every finding's `id` is a stable hash of its kind and signature, never of `at` or of
 * anything else that would change between two calls over the same facts -- `enqueue.ts`
 * depends on that stability to stay idempotent.
 */
import { createHash } from 'node:crypto';

import type { Gotcha } from '../gotcha.js';
import type { ForgeEvent, RunState } from '../journal.js';

export type SelfFindingKind =
  | 'gotcha-fix-lane'
  | 'tick-error-repeat'
  | 'coverage-miss-repeat'
  | 'token-outlier'
  | 'health-repeat'
  | 'repeated-work';

export interface SelfFinding {
  /** sha256(kind + '|' + signature).slice(0, 16), so the same underlying fact always
   *  produces the same finding id across two separate analysis runs. */
  id: string;
  kind: SelfFindingKind;
  /** What makes this finding this finding, not another one of the same kind -- a gotcha
   *  id, an error message, a member name, a run name, a health signal, or a tool shape. */
  signature: string;
  /** One sentence a person (or a worker reading its own brief) can act on. */
  summary: string;
  /** Concrete, quotable evidence: the rows or facts that justify the finding, never a
   *  paraphrase of them. */
  evidence: string[];
}

/** One round's coverage, as read off a `CouncilAttestation` on disk. Kept narrow rather
 *  than the full attestation shape, so this module never has to import `contracts.ts`'s
 *  zod schema just to read one field two levels deep. */
export interface AttestationRoundInput {
  repo: string;
  pr: number;
  round: number;
  missing: string[];
}

/** One run's shape, for F.6. `toolSequence` is tool *names* only (`tool.start`'s own
 *  journaled field) -- Forge does not journal the command or the file a tool touched
 *  today, so a finer signature (by file set, by normalized command) is a real gap this
 *  detector cannot close until that is journaled too; noted here rather than pretended
 *  away. `gotchaIds` and `parkReasons` widen the signature to catch a repeat that shares
 *  no tool shape but does share what broke or why the run stopped. */
export interface RunTranscript {
  run: string;
  ticket?: string;
  toolSequence: string[];
  gotchaIds: string[];
  parkReasons: string[];
}

export interface SelfAnalyzeInputs {
  gotchas: Gotcha[];
  events: ForgeEvent[];
  runs: RunState[];
  attestationRounds: AttestationRoundInput[];
  runTranscripts: RunTranscript[];
  /** Defaults to `Date.now()`. Passed explicitly so a specimen can pin "24 hours ago"
   *  without depending on the wall clock. */
  now?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TICK_ERROR_THRESHOLD = 3;
const HEALTH_REPEAT_THRESHOLD = 3;
const COVERAGE_MISS_THRESHOLD = 2;
const TOKEN_OUTLIER_MULTIPLE = 3;

function findingId(kind: SelfFindingKind, signature: string): string {
  return createHash('sha256').update(`${kind}|${signature}`).digest('hex').slice(0, 16);
}

function finding(kind: SelfFindingKind, signature: string, summary: string, evidence: string[]): SelfFinding {
  return { id: findingId(kind, signature), kind, signature, summary, evidence };
}

// ---------------------------------------------------------------------------------------
// gotcha-fix-lane
// ---------------------------------------------------------------------------------------

function gotchaFixLaneFindings(gotchas: Gotcha[]): SelfFinding[] {
  return gotchas
    .filter((g) => g.lane === 'fix')
    .map((g) => finding(
      'gotcha-fix-lane',
      g.id,
      `gotcha ${g.id} (${g.where}) is classified into the fix lane and has not been fixed`,
      [`what: ${g.what}`, `where: ${g.where}`, `error: ${g.error}`, `prevention: ${g.prevention}`, `hits: ${g.hits}`],
    ));
}

// ---------------------------------------------------------------------------------------
// tick-error-repeat
// ---------------------------------------------------------------------------------------

function tickErrorRepeatFindings(events: ForgeEvent[], now: number): SelfFinding[] {
  const byMessage = new Map<string, ForgeEvent[]>();
  for (const event of events) {
    if (event.event !== 'queue.tick-error') continue;
    if (now - event.at > DAY_MS) continue;
    const message = String((event as { message?: unknown }).message ?? '');
    if (!message) continue;
    const list = byMessage.get(message) ?? [];
    list.push(event);
    byMessage.set(message, list);
  }
  const out: SelfFinding[] = [];
  for (const [message, rows] of byMessage) {
    if (rows.length < TICK_ERROR_THRESHOLD) continue;
    out.push(finding(
      'tick-error-repeat',
      message,
      `the queue tick has failed with the same error ${rows.length} times in the last 24 hours`,
      rows.map((r) => `${new Date(r.at).toISOString()}: ${message}`),
    ));
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// coverage-miss-repeat
// ---------------------------------------------------------------------------------------

function coverageMissRepeatFindings(rounds: AttestationRoundInput[]): SelfFinding[] {
  const byMember = new Map<string, AttestationRoundInput[]>();
  for (const round of rounds) {
    for (const member of round.missing) {
      const list = byMember.get(member) ?? [];
      list.push(round);
      byMember.set(member, list);
    }
  }
  const out: SelfFinding[] = [];
  for (const [member, rounds_] of byMember) {
    if (rounds_.length < COVERAGE_MISS_THRESHOLD) continue;
    out.push(finding(
      'coverage-miss-repeat',
      member,
      `council member "${member}" was missing from ${rounds_.length} rounds`,
      rounds_.map((r) => `${r.repo} #${r.pr} round ${r.round}: missing ${member}`),
    ));
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// token-outlier
// ---------------------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function tokenOutlierFindings(runs: RunState[]): SelfFinding[] {
  const byClass = new Map<string, RunState[]>();
  for (const run of runs) {
    const className = run.className ?? 'unknown';
    const list = byClass.get(className) ?? [];
    list.push(run);
    byClass.set(className, list);
  }
  const out: SelfFinding[] = [];
  for (const [className, classRuns] of byClass) {
    // A median of one run's own token count would make every run its own outlier the
    // moment it used any tokens at all; at least three runs are needed for "3x the
    // median" to mean anything.
    if (classRuns.length < 3) continue;
    const med = median(classRuns.map((r) => r.tokensUsed));
    if (med <= 0) continue;
    for (const run of classRuns) {
      if (run.tokensUsed <= med * TOKEN_OUTLIER_MULTIPLE) continue;
      out.push(finding(
        'token-outlier',
        run.run,
        `run ${run.run} (class ${className}) used ${run.tokensUsed} tokens, over ${TOKEN_OUTLIER_MULTIPLE}x `
          + `the class median of ${med}`,
        [`run: ${run.run}`, `class: ${className}`, `tokensUsed: ${run.tokensUsed}`, `median: ${med}`],
      ));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// health-repeat
// ---------------------------------------------------------------------------------------

function healthRepeatFindings(events: ForgeEvent[]): SelfFinding[] {
  const bySignal = new Map<string, ForgeEvent[]>();
  for (const event of events) {
    if (event.event !== 'warden.health') continue;
    const signal = String((event as { signal?: unknown }).signal ?? '');
    if (!signal) continue;
    const list = bySignal.get(signal) ?? [];
    list.push(event);
    bySignal.set(signal, list);
  }
  const out: SelfFinding[] = [];
  for (const [signal, rows] of bySignal) {
    if (rows.length < HEALTH_REPEAT_THRESHOLD) continue;
    out.push(finding(
      'health-repeat',
      signal,
      `the warden has reported "${signal}" ${rows.length} times`,
      rows.map((r) => `${new Date(r.at).toISOString()}: key ${String((r as { key?: unknown }).key ?? '?')}`),
    ));
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// repeated-work (F.6)
// ---------------------------------------------------------------------------------------

/** The shape a run's transcript reduces to, for matching against other runs. Three
 *  independent signals, any one of which is enough to call two runs "the same shape":
 *  the exact tool-call sequence, a shared gotcha, or a shared park reason. */
function shapesOf(t: RunTranscript): string[] {
  const shapes: string[] = [];
  if (t.toolSequence.length > 0) shapes.push(`tools:${t.toolSequence.join('>')}`);
  for (const gotchaId of t.gotchaIds) shapes.push(`gotcha:${gotchaId}`);
  for (const reason of t.parkReasons) shapes.push(`park:${reason}`);
  return shapes;
}

/** A session for this purpose is "whatever ticket the run belongs to", falling back to
 *  the run's own name for a transcript with no ticket -- two runs need to come from
 *  visibly different tickets or sessions before a shared shape counts as *repeated* work
 *  rather than one long-running job restating itself. */
function sessionOf(t: RunTranscript): string {
  return t.ticket ?? t.run;
}

function repeatedWorkFindings(transcripts: RunTranscript[]): SelfFinding[] {
  const byShape = new Map<string, RunTranscript[]>();
  for (const t of transcripts) {
    for (const shape of shapesOf(t)) {
      const list = byShape.get(shape) ?? [];
      list.push(t);
      byShape.set(shape, list);
    }
  }
  const out: SelfFinding[] = [];
  for (const [shape, runs] of byShape) {
    const sessions = new Set(runs.map(sessionOf));
    if (sessions.size < 2) continue;
    out.push(finding(
      'repeated-work',
      shape,
      `the same work shape ("${shape}") recurred across ${sessions.size} different tickets/sessions -- `
        + 'author a routine for it',
      runs.map((r) => `run ${r.run} (ticket ${sessionOf(r)})`),
    ));
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------------------

export function analyze(inputs: SelfAnalyzeInputs): SelfFinding[] {
  const now = inputs.now ?? Date.now();
  return [
    ...gotchaFixLaneFindings(inputs.gotchas),
    ...tickErrorRepeatFindings(inputs.events, now),
    ...coverageMissRepeatFindings(inputs.attestationRounds),
    ...tokenOutlierFindings(inputs.runs),
    ...healthRepeatFindings(inputs.events),
    ...repeatedWorkFindings(inputs.runTranscripts),
  ];
}
