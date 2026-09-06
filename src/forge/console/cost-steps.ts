/**
 * `GET /run/:id/cost`: the cost sheet's "by step" table. One row per journal event this
 * run recorded that carried real usage -- the run's own token counts, straight off the
 * journal, never a dollar figure derived by multiplying them against a list price. This
 * fleet runs on a flat subscription: no dollar is ever actually spent, so a `$` here
 * would be fiction wearing a number's shape.
 */
import type { ForgeEvent } from '../journal.js';
import type { CostStep } from '../../shared/console-model.js';
import { jidFor, textFor } from './journal-route.js';

export function computeCostSteps(run: string, events: ForgeEvent[]): CostStep[] {
  const steps: CostStep[] = [];
  for (const row of events) {
    if (row.run !== run || !row.usage) continue;
    const tokens = row.usage.input + row.usage.cacheRead + row.usage.cacheCreation + row.usage.output;
    steps.push({
      t: row.at,
      stepText: textFor(row),
      inputTokens: row.usage.input,
      outputTokens: row.usage.output,
      tokens,
    });
  }
  return steps;
}

/** The jid of the last `rule.enforced` decision this run has on record, but only when
 *  the lane is still `runaway` despite it -- the real analog of the prototype's
 *  fabricated "cap event failed (J-40211)" detail. A lane that enforcement actually
 *  parked or killed is not runaway any more (see `lanes.ts`'s own state derivation), so
 *  a record here always means enforcement fired and the run kept going regardless. */
export function findCapEnforcementFailure(run: string, events: ForgeEvent[], runaway: boolean): string | null {
  if (!runaway) return null;
  let last: ForgeEvent | undefined;
  for (const row of events) {
    if (row.run === run && row.event === 'decision.made' && row.action === 'rule.enforced') last = row;
  }
  return last ? jidFor(last) : null;
}
