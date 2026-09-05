/**
 * Dispatcher decision 7: weekly chaos runs against a specimen config dir are Phase 7,
 * not this stream. This stub exists so a caller that reaches for `forge chaos` gets a
 * plain refusal instead of silence or, worse, a fake pass -- "not built" is the honest
 * answer, and the wiring into the CLI itself is Console's, same as the manifest command.
 */
export interface ChaosResult {
  ran: false;
  reason: 'not built';
}

export function runChaos(): ChaosResult {
  return { ran: false, reason: 'not built' };
}
