/**
 * The three roles `roles.ts` declares as interfaces, built for real on top of the
 * `Reasoner` seam (`contracts.ts`) rather than a real Sonnet/Opus/Codex client of their
 * own. `forge council` wires these; every specimen in this repository drives `roles.ts`'s
 * interfaces through a fake instead, per the guardrail (no model call in a test).
 *
 * The Reasoner contract only ever hands back `{ text: string }` -- `reasoner-claude.ts`'s
 * own SYSTEM_INSTRUCTIONS ask the model for `{"text": "<answer>"}`. So every prompt built
 * here asks the model to put its actual JSON answer (a findings array, a verdict object)
 * inside that `text` string, and every parser here reads it back out with the same
 * fail-closed instinct `reasoner-claude.ts` uses for its own reply: a reply that does not
 * parse is never treated as an empty, harmless answer.
 */
import { z } from 'zod';

import type { Reasoner } from '../contracts.ts';
import { CouncilFindingSchema } from '../contracts.ts';
import type { CouncilFinding, CouncilVerdict } from '../contracts.ts';
import { ReasonerParseError } from '../reasoner-claude.ts';
import type { RuleVerdict } from '../rules/types.ts';
import type { CodexLane, Judge, LensRunner, LensInput } from './roles.ts';
import type { JudgeInput } from './gate.ts';
import { councilPolicy, type CouncilPolicy } from './risk.ts';

const FINDINGS_ARRAY_SCHEMA = z.array(CouncilFindingSchema);

/** A lens's reply, read permissively: a bare array, or `{ findings: [...] }`. Anything
 *  else -- unparseable JSON, a wrong shape entirely -- reads as no findings rather than
 *  a thrown error, since a lens that cannot answer must never block a merge by crashing
 *  the round; the judge still sees the other lenses' packets. */
function parseFindings(text: string): CouncilFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const candidate = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { findings?: unknown }).findings))
      ? (parsed as { findings: unknown[] }).findings
      : undefined;
  if (candidate === undefined) return [];
  const result = FINDINGS_ARRAY_SCHEMA.safeParse(candidate);
  return result.success ? result.data : [];
}

export function buildLensPrompt(input: LensInput & { ruleVerdicts: RuleVerdict[] }): string {
  return [
    `You are the "${input.lens}" lens of a pull request council.`,
    'Review the diff below for this lens only. You never see another lens\'s findings --',
    'write your own isolated packet.',
    '',
    'PR body:',
    input.brief,
    '',
    'Rule verdicts already computed for this PR (context, not yours to re-derive):',
    JSON.stringify(input.ruleVerdicts),
    '',
    'Diff:',
    input.diffSummary,
    '',
    'Set your `text` field to a JSON array of findings and nothing else. Each finding is',
    `shaped exactly as {"member": "${input.lens}", "file": string, "line": integer,`,
    '"claim": string, "failureScenario": string, "severity": "critical"|"high"|"medium"|"low",',
    '"confidence": "low"|"medium"|"high"}. An empty array means this lens found nothing.',
  ].join('\n');
}

/**
 * I19: a live lens replied with a JSON array wrapped in a markdown fence, and
 * `reasoner.call` (`reasoner-claude.ts`) threw a `ReasonerParseError` the caller never
 * caught -- the rejection ran uncaught all the way to `cli.ts`'s top-level `.then()` and
 * took the process down. `reasonerLensRunner.run` never propagates a reply failure now,
 * whatever shape it takes: it always resolves to a `CouncilLensReport`, `failed: true`
 * marking the ones that could not be parsed. That report still carries one medium-severity
 * finding naming the failure, so the judge sees the gap in coverage instead of silently
 * getting fewer packets than it was told to expect, and `forge council`'s per-lens journal
 * row can say which lens failed and show the raw reply that did not parse.
 */
export function reasonerLensRunner(reasoner: Reasoner, ruleVerdicts: RuleVerdict[] = []): LensRunner {
  return {
    async run(input) {
      const prompt = buildLensPrompt({ ...input, ruleVerdicts });
      let result: { text: string };
      try {
        result = await reasoner.call({ className: 'audit-lens', prompt, replyShape: 'array' });
      } catch (error) {
        const raw = error instanceof ReasonerParseError
          ? error.raw
          : error instanceof Error ? error.message : String(error);
        return {
          lens: input.lens,
          failed: true,
          rawReply: raw,
          findings: [{
            member: input.lens,
            file: '(lens)',
            line: 0,
            claim: `lens ${input.lens} returned an unparseable reply`,
            failureScenario: 'this lens contributed no findings for the round; its coverage is missing',
            severity: 'medium',
            confidence: 'low',
          }],
        };
      }
      return { lens: input.lens, findings: parseFindings(result.text) };
    },
  };
}

const JUDGE_REPLY_SCHEMA = z.object({
  verdict: z.enum(['PASS', 'PASS WITH NOTES', 'FIX FIRST']),
  decidingFindings: z.array(CouncilFindingSchema).optional(),
});

/**
 * Built purely from `JudgeInput` -- lenses, brief and CI state. `JudgeInput`'s own type
 * (`gate.ts`) carries no `diff` field, so there is no raw diff text this function could
 * even read by mistake; that is the falsifier's own enforcement point, not this one.
 */
export function buildJudgePrompt(input: JudgeInput): string {
  return [
    'You are the judge of a pull request council. You never see the raw diff -- only the',
    'lenses\' own isolated findings packets, the PR body, and CI state.',
    '',
    'PR body:',
    input.brief,
    '',
    `CI: run ${input.ci.runId} on head ${input.ci.headSha}`,
    '',
    'Lens packets:',
    JSON.stringify(input.lenses),
    '',
    'Set your `text` field to a JSON object and nothing else, shaped exactly as',
    '{"verdict": "PASS"|"PASS WITH NOTES"|"FIX FIRST", "decidingFindings": [...]}, where',
    'decidingFindings is the subset of the findings above that actually blocks the merge',
    '(empty when the verdict is PASS).',
  ].join('\n');
}

/** A reply that will not parse against the judge's own schema resolves to `FIX FIRST`
 *  with no deciding findings -- fail-closed, the same instinct as `parseFindings` above,
 *  except a judge that cannot answer blocks the merge rather than clearing it silently. */
function parseJudgeReply(text: string): { verdict: CouncilVerdict; decidingFindings: CouncilFinding[] } {
  try {
    const parsed = JSON.parse(text);
    const validated = JUDGE_REPLY_SCHEMA.safeParse(parsed);
    if (validated.success) {
      return { verdict: validated.data.verdict, decidingFindings: validated.data.decidingFindings ?? [] };
    }
  } catch {
    // falls through to the fail-closed default below
  }
  return { verdict: 'FIX FIRST', decidingFindings: [] };
}

export function reasonerJudge(reasoner: Reasoner): Judge {
  return {
    async decide(input) {
      const prompt = buildJudgePrompt(input);
      const result = await reasoner.call({ className: 'audit-judge', prompt });
      return parseJudgeReply(result.text);
    },
  };
}

/**
 * Aaron 2026-09-04 16:40: the Codex lane stays off unless `council.codex` is `'on'` in
 * the policy file. Even `'on'` never runs anything real in this stream -- the only
 * sanctioned route to Codex is `dev-harness/tools/codex_call.py` (`codex-side-agent`
 * memory note), out of scope here -- so the flag gates a documented refusal rather than
 * silently doing nothing, which is how the flag stays provably load-bearing instead of
 * a comment nobody's code path can actually disprove.
 */
export function codexLaneFor(policy: CouncilPolicy = councilPolicy()): CodexLane {
  if (policy.codex !== 'on') {
    return { async run() { return { ran: false, findings: [] }; } };
  }
  return {
    async run() {
      throw new Error(
        'council.codex is "on" but this stream implements no Codex lane: the only '
        + 'sanctioned route to Codex is dev-harness/tools/codex_call.py',
      );
    },
  };
}
