/**
 * Reading "is anything live" out of the console's own `/state` response,
 * without pulling in the server's types. A run is live unless it is in one
 * of the three terminal states the server itself defines (`done`, `failed`,
 * `killed`); everything else, including `queued` and `parked`, still holds a
 * claim on the fleet and must not be pulled out from under by a quit.
 */
const TERMINAL_RUN_STATES = new Set(['done', 'failed', 'killed']);

export interface FleetStateResponse {
  lanes?: { value?: Array<{ run_state?: unknown }> };
}

export function hasLiveRun(state: FleetStateResponse): boolean {
  const lanes = state.lanes?.value ?? [];
  return lanes.some((lane) => {
    const runState = typeof lane.run_state === 'string' ? lane.run_state : undefined;
    return runState !== undefined && !TERMINAL_RUN_STATES.has(runState);
  });
}
