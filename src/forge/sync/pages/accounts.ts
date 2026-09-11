/**
 * Manual (or timed) re-sync for the Accounts page: force a fresh read of every account
 * (`AccountsService.refreshAll`) before reporting which ones came back with an error --
 * the settings page's `list()` cache never triggers a wait, so a sync is the only place
 * that reads a genuinely fresh row before reporting on it.
 */
import type { StageResult } from './sessions.js';

export interface SyncAccountsDeps {
  refreshAll(): Promise<void>;
  list(): Array<{ id: string; readError?: string }>;
}

export async function syncAccounts(deps: SyncAccountsDeps): Promise<StageResult> {
  await deps.refreshAll();
  const rows = deps.list();
  const failedIds = rows.filter((row) => row.readError).map((row) => row.id);
  const counts = { probed: rows.length, ok: rows.length - failedIds.length, failed: failedIds.length };
  const message = failedIds.length > 0
    ? `${counts.ok} ok, ${counts.failed} failed: ${failedIds.join(', ')}`
    : `${counts.ok} ok`;
  return { counts, message };
}

export interface AccountsProbeJournal {
  append: (row: { event: 'accounts.probed'; actor: 'sync'; ok: number; failed: number }) => unknown;
}

/**
 * The 10-minute re-probe cadence for the Accounts page: nothing else refreshes a
 * login's reading once the Settings page is closed. One `accounts.probed` row per
 * firing, never more even on a run of failures -- a bad probe is guarded the same as
 * every other tick in `cli.ts` and never stops the timer.
 */
export function scheduleAccountsProbeTick(deps: {
  seconds: number;
  accounts: SyncAccountsDeps;
  journal: AccountsProbeJournal;
}): NodeJS.Timeout {
  const tick = setInterval(() => {
    void syncAccounts(deps.accounts)
      .then((result) => {
        deps.journal.append({ event: 'accounts.probed', actor: 'sync', ok: result.counts['ok'] ?? 0, failed: result.counts['failed'] ?? 0 });
      })
      .catch(() => {
        // Guarded like every other tick in cli.ts: one bad probe never stops the timer.
      });
  }, deps.seconds * 1000);
  tick.unref();
  return tick;
}
