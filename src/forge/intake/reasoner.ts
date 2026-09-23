/**
 * Requirement 6: the Intake planner always reasons on `claude` (Aaron, 2026-09-23: the
 * old Codex planning route was removed outright). `resolvePlanProvider` is the one
 * function that decision routes through; nothing in this stream picks `'codex'`.
 *
 * This module never constructs a Codex client. `codex_call.py` is the only sanctioned
 * route to Codex at all (memory `codex-side-agent.md`), and it is out of scope for
 * Intake's own build: the concrete `Reasoner` a production planner uses is wired at the
 * integration point (P4.7), not here. Every specimen in this stream calls
 * `resolvePlanProvider` with a plain object, never a real policy file mutated at
 * runtime, so this file makes zero model calls of its own, ever.
 */
import type { Provider } from '../contracts.js';
import type { Policy } from '../policy.js';

export function resolvePlanProvider(_reasonerConfig: Policy['reasoner']): Provider {
  return 'claude';
}

/**
 * When the Codex ledger cap (P3.2) is reached mid-run, the planner falls back to Claude
 * and journals the fallback rather than retrying Codex or failing the run outright
 * (decision 3). `onFallback` is the caller's own journal-write hook; this function only
 * decides whether a fallback happened.
 */
export function planProviderWithLedgerFallback(
  reasonerConfig: Policy['reasoner'],
  ledgerCapReached: boolean,
  onFallback?: (from: Provider, to: Provider) => void,
): Provider {
  const wanted = resolvePlanProvider(reasonerConfig);
  if (wanted === 'codex' && ledgerCapReached) {
    onFallback?.('codex', 'claude');
    return 'claude';
  }
  return wanted;
}
