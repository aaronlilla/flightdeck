/**
 * Pulls the typed Haiping handoff (`contracts.ts`'s `HaipingHandoffSchema`) out of a PR
 * body's own fenced JSON blocks. `forge gate` needs to know whether a complete handoff
 * exists before it ever clears a merge (decision 7: "an incomplete one fails the gate"),
 * and a PR body is free-form Markdown -- this is the one place that goes looking rather
 * than every caller inventing its own scan.
 */
import { checkHandoff } from '../contracts.ts';
import type { HaipingHandoff } from '../contracts.ts';

const FENCE_RE = /```json\s*([\s\S]*?)```/g;

/** The first fenced JSON block in `body` that validates as a complete `HaipingHandoff`,
 *  or `undefined` when none does -- a body with no such block, or several that are each
 *  incomplete, both read the same way: no handoff found. */
export function findHaipingHandoff(body: string): HaipingHandoff | undefined {
  for (const match of body.matchAll(FENCE_RE)) {
    const block = match[1];
    if (!block) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    if (checkHandoff('haiping', parsed).complete) return parsed as HaipingHandoff;
  }
  return undefined;
}
