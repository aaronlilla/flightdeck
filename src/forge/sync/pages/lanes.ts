/**
 * Manual re-sync for the Board (lanes) page: re-check every lane, one at a time.
 * Sequential on purpose (never `Promise.all`): each recheck is a GitHub read, and the
 * rate limit is a fleet ceiling shared by every session on this machine, not a per-lane
 * budget (order: github-rate-limit-is-a-fleet-ceiling).
 */
import type { StageResult } from './sessions.js';

export interface SyncLanesDeps {
  lanes(): Array<{ id: string }>;
  recheck(id: string): Promise<boolean>;
}

export async function syncLanes(deps: SyncLanesDeps): Promise<StageResult> {
  const lanes = deps.lanes();
  let changed = 0;
  let failed = 0;
  for (const lane of lanes) {
    try {
      const didChange = await deps.recheck(lane.id);
      if (didChange) changed += 1;
    } catch {
      failed += 1;
    }
  }
  const counts = { lanes: lanes.length, changed, failed };
  return { counts, message: `${changed} changed, ${failed} failed of ${lanes.length} lane(s)` };
}
