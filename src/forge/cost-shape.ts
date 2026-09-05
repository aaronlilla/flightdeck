/**
 * Alive and wasting money: a shape the hard context ceiling never catches.
 *
 * "300K context, 90% cache reads, no writes in thirty turns is alive and wasting money."
 * That session is under its class ceiling the whole time -- `liveness.ts`'s own `context`
 * signal never trips -- because the ceiling is about a hard limit, not about whether the
 * tokens being re-read on every turn are buying any forward progress. This is a second,
 * distinct signal for that, parked rather than killed, and reported with its own hint so
 * a park here is never mistaken for a context-ceiling park in a report or a specimen.
 */
import type { ExtendedStuckSignal } from './contracts.js';
import type { WardenConfig } from './policy.js';

export interface CostShapeInput {
  run: string;
  context: number;
  cacheReadTokens: number;
  totalReadTokens: number;
  turnsSinceWrite: number;
  now: number;
}

/**
 * `undefined` unless every one of the three thresholds is met at once: a session that is
 * merely large, or merely cache-heavy, or merely quiet on writes for a while, is not the
 * shape this exists to catch -- only all three together is.
 */
export function assessCostShape(input: CostShapeInput, config: WardenConfig): ExtendedStuckSignal | undefined {
  const ratio = input.totalReadTokens > 0 ? input.cacheReadTokens / input.totalReadTokens : 0;
  const tripped = input.context >= config.contextHigh
    && ratio >= config.cacheReadRatio
    && input.turnsSinceWrite >= config.turnsWithoutWrite;
  if (!tripped) return undefined;

  return {
    key: input.run,
    signal: 'cost-shape',
    threshold: config.contextHigh,
    observed: input.context,
    since: input.now,
    hint: `run ${input.run} is at ${input.context} tokens, ${Math.round(ratio * 100)}% cache-read, `
      + `${input.turnsSinceWrite} turns without a write: alive and wasting money, not a context `
      + 'ceiling trip',
  };
}
