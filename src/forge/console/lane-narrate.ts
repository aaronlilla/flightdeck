/**
 * The board tile's three sentences, and who is allowed to have written each one.
 *
 * Split out of `reads.ts` so the rule can be tested the way the rail's is: with a real
 * `Narrator` over a fake query, counting what reached the model. Two of the three
 * sentences are composed here or in `laneGlance.ts` out of the lane's own machine-
 * readable rows, and the narrator may rewrite those. The third, `did`, is the agent's
 * own report whenever `didVerbatim` says so, and rewriting it would put one report in
 * front of the operator in two voices -- the agent's on the rail, the model's on the
 * tile.
 */
import type { Lane, NarrationBag } from '../../shared/console-model.js';

import { Binder } from './narrate-bind.js';
import { didFactsFor, youFactsFor } from './laneGlance.js';
import { plainFactsFor } from './plain.js';
import type { Narrator } from './narrate-store.js';

/**
 * The three board-tile sentences, through the narrator.
 *
 * `did`, `now` and `you` keep their own string type -- what changes is who wrote the
 * string, which is now always the narrator's `glance` register. The other two
 * registers go into the lane's own `narration` bag, so the sheet can show `detail`
 * and `?verbose=1` can show `raw` without either one being able to reach the tile.
 *
 * A lane parked on the operator's own question, and a `you` line that quotes it, go
 * through `Binder.verbatim`: no model call, no cache key, three identical registers.
 */
export function narrateLaneFields(lane: Lane, narrator: Narrator | null): void {
  const bag: NarrationBag = {};
  const binder = new Binder(narrator, 'lanes');
  const ref = lane.ticket ?? lane.id;

  // `didVerbatim` marks the agent's own report. Same rule the rail already applies to
  // a `forge.report` row, applied here so one report cannot reach the operator in two
  // voices.
  const did = lane.didVerbatim
    ? binder.verbatim(bag, 'did', lane.did)
    : binder.field(bag, 'did', didFactsFor(lane, lane.did), ref);
  if (did !== null) lane.did = did;

  const plainFacts = plainFactsFor(lane, lane.plain, { now: Date.now() });
  const now = plainFacts
    ? binder.field(bag, 'now', plainFacts, ref)
    : binder.verbatim(bag, 'now', lane.plain);
  if (now !== null) {
    lane.now = now;
    // The brief's own alias: `plain` is `now.glance` and nothing else, so no consumer
    // can end up reading a sentence the narrator never wrote.
    lane.plain = now;
  }

  const youFacts = youFactsFor(lane, lane.you);
  const you = youFacts
    ? binder.field(bag, 'you', youFacts, ref)
    : binder.verbatim(bag, 'you', lane.you);
  if (you !== null) lane.you = you;

  if (Object.keys(bag).length > 0) lane.narration = bag;
}

