/**
 * The sentence under each flight-review tile.
 *
 * These were composed in `FlightReview.tsx`, which put them out of the narrator's reach:
 * a sentence the server never wrote is one the model cannot rewrite and the checker
 * cannot referee. They live here, shared, because the stub server's fixtures must produce
 * exactly the sentences the real route produces -- a second copy of this text is a second
 * answer, and the drifted copy is the one a parity run would not catch.
 *
 * Keyed by tile so a caller cannot pair a note with the wrong number.
 */
import type { ReviewMetrics } from './console-model.js';
import { fmtTokens } from './format-tokens.js';

export type ReviewTile = 'ticketsIn' | 'mergedToday' | 'handedToQa' | 'blockersCleared' | 'tokensToday' | 'slowestHop';

export function reviewNotesFor(
  metrics: ReviewMetrics, tokensToday: number, dailyTokens: number | null,
): Record<ReviewTile, string> {
  const capNote = dailyTokens && Number.isFinite(dailyTokens)
    ? `${Math.round((tokensToday / dailyTokens) * 100)}% of the daily cap.`
    : 'No daily cap is set.';
  const perMerge = metrics.tokensPerMerge !== null ? ` ${fmtTokens(metrics.tokensPerMerge)} per merge.` : '';
  const slowest = metrics.slowestHop;
  return {
    ticketsIn: 'Picked up from Ready for Dev since midnight.',
    mergedToday: metrics.mergedToday > 0 ? 'Merged by the fleet today.' : 'Nothing has merged yet today.',
    handedToQa: 'Tickets moved to QA with a test plan today.',
    blockersCleared: 'Cleared today, by you or on their own.',
    tokensToday: `${capNote}${perMerge}`,
    slowestHop: slowest
      ? `${slowest.name}.`
      : metrics.humanWaitMin > 0 ? 'Waiting for your answers.' : 'No step waited on anything today.',
  };
}
