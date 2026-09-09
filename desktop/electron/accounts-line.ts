/**
 * One line for the status window on what the console knows about its accounts, read
 * from `GET /accounts` right after the console is reachable. Pure summary here; the
 * fetch lives in `main.ts` with the rest of the console calls. The request carries the
 * console's own server token (`~/.forge/server-token`), which is this app's key to
 * its own console and never an account credential.
 */
export interface AccountsLineInput {
  accounts?: Array<{
    id?: unknown; provider?: unknown; connected?: unknown; liveRuns?: unknown;
    paused?: { until?: unknown } | null;
    fiveHour?: { utilization?: unknown } | null;
  }>;
}

export function accountsLine(response: AccountsLineInput): string {
  const rows = (response.accounts ?? []).filter((row) => row.provider === 'claude');
  if (rows.length === 0) return 'Accounts: none registered.';
  const parts = rows.map((row) => {
    const id = typeof row.id === 'string' ? row.id : '?';
    const live = typeof row.liveRuns === 'number' ? row.liveRuns : 0;
    const used = row.fiveHour && typeof row.fiveHour.utilization === 'number' ? `${Math.round(row.fiveHour.utilization)}% of five hours` : 'windows not measured';
    if (row.paused) return `${id} paused`;
    if (row.connected === 'no') return `${id} not connected`;
    if (row.connected === 'unknown') return `${id} not checked`;
    return `${id} ${used}${live ? `, ${live} live` : ''}`;
  });
  const connected = rows.filter((row) => row.connected === 'yes').length;
  return `Accounts: ${connected} of ${rows.length} Claude connected (${parts.join('; ')}).`;
}
