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
  // What the journal already says about each run: the figures on its last
  // `burn.mismatch` row. A restart used to forget the in-memory set and re-journal
  // every open mismatch, one row per run per `forge up`: 11,216 rows for 291 runs by
  // 2026-09-09, most of them the same two numbers again. The journal is the memory that
  // survives a restart, and a row is written only when the figures moved.
  const told = new Map<string, string>();
  for (const event of state.events) {
    if (event.event === 'burn.mismatch' && event.run) told.set(event.run, figuresKey(event));
  }
  const fresh: Array<Partial<ForgeEvent>> = [];
  for (const event of mismatches) {
    const run = event.run;
    if (!run) continue;
    const key = figuresKey(event);
    const memo = `${run}|${key}`;
    if (reported.has(memo) || told.get(run) === key) continue;
    reported.add(memo);
    fresh.push(event);
  }
  return fresh;
}

/** The two sums as the row states them, to the cent: what "the same mismatch" means. */
function figuresKey(event: Partial<ForgeEvent>): string {
  const cents = (value: unknown): string => (typeof value === 'number' ? Math.round(value * 100).toString() : '?');
  return `${cents(event['resultUsd'])}|${cents(event['perMessageUsd'])}`;
}
