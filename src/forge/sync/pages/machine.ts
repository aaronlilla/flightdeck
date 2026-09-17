/**
 * Manual re-sync for the Machine page: force one fresh process-table read rather than
 * waiting on the console's own 10 s ticker, since the page otherwise shows whatever the
 * last automatic read happened to catch.
 */
import type { StageResult } from './sessions.js';

export interface SyncMachineDeps {
  snapshot(): Promise<{ sessions: number; processes: number }>;
}

export async function syncMachine(deps: SyncMachineDeps): Promise<StageResult> {
  try {
    const counts = await deps.snapshot();
    return { counts, message: `read at ${new Date().toISOString()}, next automatic read in 10 s` };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { counts: {}, message: reason };
  }
}
