/**
 * P4.7/I3: the `forge up` cadence that calls the Governor's `reconcileBurn`.
 *
 * `reconcileBurn` itself is pure and re-derives the same mismatch from the same journal
 * on every call, so calling it unconditionally on a 30s tick would journal one
 * `burn.mismatch` row per run per tick for as long as the divergence stayed open. This
 * wraps it with the one thing a tick needs that a pure function cannot own: "already
 * told you about this run" memory, kept by the caller (an in-memory `Set`, per process)
 * rather than by re-scanning the journal for a prior `burn.mismatch` row on every tick.
 */
import { buildBurnLedger, reconcileBurn } from './governor.js';
import type { FleetState, ForgeEvent } from './journal.js';

/**
 * Every run `reconcileBurn` flags that has not already been reported through `reported`.
 * Mutates `reported` in place, adding the run ids this call surfaces, so the same run's
 * unresolved mismatch is journaled once rather than every tick it stays open.
 */
export function reconcileBurnOnce(
  state: FleetState, reported: Set<string>,
): Array<Partial<ForgeEvent>> {
  const ledger = buildBurnLedger(state.events);
  const mismatches = reconcileBurn(state, ledger);
  const fresh: Array<Partial<ForgeEvent>> = [];
  for (const event of mismatches) {
    const run = event.run;
    if (!run || reported.has(run)) continue;
    reported.add(run);
    fresh.push(event);
  }
  return fresh;
}
