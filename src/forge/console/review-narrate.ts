/**
 * The flight review's six tile sentences, narrated.
 *
 * Each note describes one number the tile above it already shows, so its facts are that
 * number and nothing else: the checker then holds the narration to it, and a sentence
 * that rounds "3 merged" up to four is refused before anybody reads it.
 *
 * The registers land on the `proposals` slice, which is the slice this whole response is
 * published on. There is no `review` slice and inventing one would break the events
 * contract in `tests/forge/server-events.test.ts` for no gain: the review screen's numbers
 * move exactly when the proposals response is recomputed.
 */
import type { NarrationBag, NarrationFacts, ProposalsResponse } from '../../shared/console-model.js';
import { reviewNotesFor, type ReviewTile } from '../../shared/review-notes.js';

import { Binder } from './narrate-bind.js';
import type { Narrator } from './narrate-store.js';

/** The one number a tile's own sentence is about. A note that names no number of its own
 *  (the fixed "picked up from Ready for Dev" line) still carries the count, so the model
 *  cannot quietly add one. */
function factsFor(
  tile: ReviewTile, response: ProposalsResponse, template: string, tokensToday: number,
): NarrationFacts {
  const metrics = response.metrics;
  const facts: Record<string, string | number | boolean | null> = {};
  if (tile === 'ticketsIn' && metrics.ticketsIn !== undefined) facts['count'] = metrics.ticketsIn;
  if (tile === 'mergedToday') facts['count'] = metrics.mergedToday;
  if (tile === 'handedToQa' && metrics.handedToQa !== undefined) facts['count'] = metrics.handedToQa;
  if (tile === 'blockersCleared' && metrics.blockersCleared !== undefined) facts['count'] = metrics.blockersCleared;
  if (tile === 'tokensToday') facts['tokens'] = tokensToday;
  if (tile === 'slowestHop' && metrics.slowestHop) {
    facts['minutes'] = metrics.slowestHop.minutes;
    facts['step'] = metrics.slowestHop.name;
  }
  return { surface: `review.${tile}`, facts: facts as NarrationFacts['facts'], template };
}

export function narrateReview(
  response: ProposalsResponse, narrator: Narrator | null,
  tokensToday: number, dailyTokens: number | null,
): ProposalsResponse {
  const notes = reviewNotesFor(response.metrics, tokensToday, dailyTokens);
  const bag: NarrationBag = {};
  const binder = new Binder(narrator, 'proposals');
  const served: Record<string, string> = {};
  for (const tile of Object.keys(notes) as ReviewTile[]) {
    const template = notes[tile];
    const glance = binder.field(bag, tile, factsFor(tile, response, template, tokensToday), tile);
    served[tile] = glance ?? template;
  }
  return {
    ...response,
    metrics: {
      ...response.metrics,
      notes: served,
      ...(Object.keys(bag).length > 0 ? { narration: bag } : {}),
    },
  };
}
