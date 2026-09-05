/**
 * Base drift and conformance drift, sharing one blocker namespace under distinct keys.
 *
 * `drift.ts`'s own doc comment keys a base-drift blocker by the base branch, so one
 * rebase clears every run behind it; that stays true of the underlying `Ask`. This file
 * is the seam that connects `driftBlocker`'s verdict to `BlockerBoard`, keyed per the
 * 2026-09-04 decision as `drift:base:<run>` -- distinct from the conformance checker's
 * own `drift:conformance:<run>` -- so a base-drift park and a conformance-drift park on
 * the same run are never mistaken for the same wall.
 */
import type { BlockerBoard } from './blockers.js';
import { driftBlocker, type Mergeable } from './drift.js';

export function baseDriftKey(run: string): string {
  return `drift:base:${run}`;
}

export function conformanceDriftKey(run: string): string {
  return `drift:conformance:${run}`;
}

export type BaseDriftOutcome = 'ok' | 'blocked';

/**
 * Raise or clear the base-drift blocker for `run`, from a fresh `readMergeable` result.
 * `MERGEABLE` is the only state that ever clears it -- `UNKNOWN` stays blocked, per
 * `drift.ts`'s own rule that an unreadable state must never be read as fine.
 */
export async function checkBaseDrift(
  blockers: BlockerBoard, run: string, state: Mergeable, base?: string,
): Promise<BaseDriftOutcome> {
  const ask = driftBlocker(run, state, base);
  if (!ask) {
    if (blockers.runsFor(baseDriftKey(run)).length) await blockers.clear(baseDriftKey(run));
    return 'ok';
  }
  await blockers.raise(baseDriftKey(run), ask.question, run);
  return 'blocked';
}
