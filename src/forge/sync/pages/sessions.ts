/**
 * Manual (or timed) re-sync for the Sessions page: run the same scan -> plan -> journal
 * path the 5 s registry tick uses (`cli.ts:793-815`), through injected `scan`/`fold`/
 * `ingest`, then run the global lock sweep once more so a re-sync also clears anything
 * the tick's own once-per-tick sweep missed between ticks.
 */
import type { StageResult } from '../../../shared/sync-contract.js';
import type { FleetState } from '../../journal.js';
import { journalRegistryRows, planRegistryRows } from '../../sessions/reconcile.js';
import { probeAlivePidLiveness } from '../../sessions/registry.js';
import type { SessionRow } from '../../sessions/registry.js';
import type { IngestDeps } from '../../sessions/ingest.js';

export type { StageResult } from '../../../shared/sync-contract.js';

export interface SyncSessionsDeps {
  scan(): SessionRow[];
  fold(): FleetState;
  ingest: IngestDeps;
  sweep(): Promise<string>;
}

export async function syncSessions(deps: SyncSessionsDeps): Promise<StageResult> {
  const scanned = deps.scan();
  const fold = deps.fold();
  const rows = planRegistryRows(scanned, fold.sessions, probeAlivePidLiveness);
  journalRegistryRows(rows, deps.ingest);

  const live = scanned.filter((row) => !row.vanished).length;
  const ended = rows.filter((row) => row.event === 'session.vanished').length;
  const counts = { live, ended, cleaned: ended };

  try {
    await deps.sweep();
    return { counts, message: 'watching every 5 s' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { counts, message: `watching every 5 s (sweep failed: ${reason})` };
  }
}
