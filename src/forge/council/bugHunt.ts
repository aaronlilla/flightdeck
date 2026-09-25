/**
 * Aaron's 2026-09-23 standing order (full autonomous mode): once the council itself is
 * clean (PASS/PASS WITH NOTES) and before an autonomous merge, a dedicated bug-hunt pass
 * runs on claude/opus-5-5 (`model-policy.json`'s `bug-hunt` class -- see that file's own
 * 2026-09-23 comment). It reads the diff plus the surrounding code hunting for real
 * defects the audit lenses were not specifically looking for, not just re-running the
 * same lens rubric a second time. Any bug it finds re-enters the ordinary fix-round loop
 * (`council/rounds.ts`) exactly like a FIX FIRST audit verdict does -- this pass never
 * merges anything itself, it only ever says whether the diff is clean.
 *
 * Built on the same `Reasoner` seam as `reasonerRoles.ts`'s lens/judge roles, so every
 * specimen for this file drives a fake `Reasoner` -- no model call in a test.
 */
import { z } from 'zod';

import type { Reasoner } from '../contracts.ts';
import { CouncilFindingSchema } from '../contracts.ts';
import type { CouncilFinding } from '../contracts.ts';

export interface BugHuntInput {
  brief: string;
  diffSummary: string;
  /** Surrounding code the diff touches, beyond the raw diff hunks -- e.g. full contents
   *  of changed files, so a bug hunt can see a callee's real behaviour, not just the
   *  lines a hunk happened to touch. Optional: a caller with no budget for this passes
   *  the diff alone, same as an ordinary lens. */
  surroundingCode?: string;
}

export interface BugHuntResult {
  clean: boolean;
  findings: CouncilFinding[];
  /** `true` when the reply could not be parsed at all -- fail-closed, same instinct as
   *  `reasonerRoles.ts`'s judge: an unreadable reply is never treated as "no bugs". */
  failed?: boolean;
}

const BUG_HUNT_REPLY_SCHEMA = z.object({
  clean: z.boolean(),
  findings: z.array(CouncilFindingSchema).optional(),
});

export function buildBugHuntPrompt(input: BugHuntInput): string {
  return [
    'You are hunting for real defects in a pull request that has already cleared its',
    'audit council (every lens and the judge came back PASS or PASS WITH NOTES). Your',
    'job is different from theirs: read the diff and the surrounding code it touches,',
    'and look for bugs an audit built around a fixed rubric would not specifically',
    'catch -- logic errors, edge cases, race conditions, resource leaks, wrong error',
    'handling, anything that would actually misbehave in production. Do not restate the',
    'audit\'s own findings; only report something you believe is a real, concrete defect.',
    '',
    'PR body:',
    input.brief,
    '',
    'Diff:',
    input.diffSummary,
    ...(input.surroundingCode ? ['', 'Surrounding code (context beyond the diff hunks):', input.surroundingCode] : []),
    '',
    'Set your `text` field to a JSON object and nothing else, shaped exactly as',
    '{"clean": boolean, "findings": [...]}, where findings is empty when clean is true,',
    'and each finding is shaped exactly as {"member": "bug-hunt", "file": string,',
    '"line": integer, "claim": string, "failureScenario": string,',
    '"severity": "critical"|"high"|"medium"|"low", "confidence": "low"|"medium"|"high"}.',
  ].join('\n');
}

function parseBugHuntReply(text: string): BugHuntResult {
  try {
    const parsed = JSON.parse(text);
    const validated = BUG_HUNT_REPLY_SCHEMA.safeParse(parsed);
    if (validated.success) {
      return { clean: validated.data.clean, findings: validated.data.findings ?? [] };
    }
  } catch {
    // falls through to the fail-closed default below
  }
  // Fail-closed: an unparseable reply is treated as "not clean, no specific findings" so
  // it re-enters the fix-round loop with a generic finding rather than sailing through to
  // merge on a reply nobody could actually read.
  return {
    clean: false,
    failed: true,
    findings: [{
      member: 'bug-hunt',
      file: '(bug-hunt)',
      line: 0,
      claim: 'the bug hunt returned an unparseable reply',
      failureScenario: 'this pass could not be read, so the item cannot be treated as clean for merge',
      severity: 'medium',
      confidence: 'low',
    }],
  };
}

export interface BugHunter {
  run(input: BugHuntInput): Promise<BugHuntResult>;
}

export function reasonerBugHunter(reasoner: Reasoner, run?: string): BugHunter {
  return {
    async run(input) {
      const prompt = buildBugHuntPrompt(input);
      const result = await reasoner.call({ className: 'bug-hunt', prompt, run });
      return parseBugHuntReply(result.text);
    },
  };
}
