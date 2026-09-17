/**
 * Live escape 2026-09-14 ~09:58: a queue-scope sync ran `stop-workers` (which engages
 * the fleet-wide kill switch) and ended at `reset-watermarks` -- no `resume` stage, and
 * `onFailure` only fires when a stage throws, so a SUCCESSFUL queue sync left the kill
 * switch engaged. Every worker launch refused for ~18 minutes until an unrelated full
 * sync's resume cleared it. The invariant: any scope whose stage list engages the kill
 * switch must end with the stage that clears it.
 */
import { describe, expect, it } from 'vitest';

import { STAGE_ORDER } from '../../../src/forge/sync/run.js';

describe('sync scope stage orders', () => {
  it('every scope that runs stop-workers ends with resume', () => {
    for (const [scope, stages] of Object.entries(STAGE_ORDER)) {
      if (stages.includes('stop-workers')) {
        expect(stages[stages.length - 1], `scope "${scope}" engages the kill switch but never clears it`).toBe('resume');
      }
    }
  });

  it('the queue scope clears the kill switch it engaged', () => {
    expect(STAGE_ORDER.queue).toContain('stop-workers');
    expect(STAGE_ORDER.queue[STAGE_ORDER.queue.length - 1]).toBe('resume');
  });
});
