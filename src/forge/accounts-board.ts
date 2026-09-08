/**
 * The fold behind `GET /accounts`: one row per registered account from the journal's
 * `account.probe` and `account.window` rows, the runs attributed to it, and (for Codex)
 * the harness tool's ledger. Pure: takes the replayed fleet state and the ledger lines,
 * never reads a file, so a specimen can pin every branch.
 */
import type { Account } from './accounts.js';
import type { FleetState, ForgeEvent, RunState } from './journal.js';
import type { AccountRow, AccountWindow, AccountsResponse } from '../shared/console-model.js';

export interface AccountsBoardInput {
  accounts: Account[];
  fleet: FleetState;
  codexLedgerLines: string[];
  now: number;
  /** The registry id every launch goes to today. */
  launchAccount: string;
}

/** Local midnight before `now`, the same day boundary `lanes.ts` uses for tokens today. */
function startOfLocalDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function emptyWindow(): AccountWindow {
  return { utilization: null, resetsAt: null, status: 'unknown', observedAt: null };
}

function foldWindow(rows: ForgeEvent[]): AccountWindow {
  const window = emptyWindow();
  for (const row of rows) {
    const status = typeof row['status'] === 'string' ? row['status'] as AccountWindow['status'] : 'unknown';
    window.status = status;
    window.observedAt = row.at;
    // An unavailable reading says the probe could not see the windows; the last known
    // numbers stay on the board rather than being blanked, and the status says so.
    if (status === 'unavailable') continue;
    if (typeof row['utilization'] === 'number') window.utilization = row['utilization'];
    if (typeof row['resetsAt'] === 'number') window.resetsAt = row['resetsAt'];
    else if (row['resetsAt'] === null) window.resetsAt = null;
  }
  return window;
}

interface CodexTotals { callsToday: number; durationTodayMs: number; lastError: string | null; lastCallAt: number | null; lastOkAt: number | null }

/**
 * The ledger `codex_call.py` appends to, one JSON object per line, folded for today.
 * Lines carry `duration_s` (the tool's own field), `ok`, `error` and `at`; a line that
 * will not parse or has no `at` is skipped rather than guessed at.
 */
export function foldCodexToday(lines: string[], now: number): CodexTotals {
  const since = startOfLocalDay(now);
  const totals: CodexTotals = { callsToday: 0, durationTodayMs: 0, lastError: null, lastCallAt: null, lastOkAt: null };
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: { at?: string; ok?: boolean; error?: string | null; duration_s?: number; duration_ms?: number };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    }
    const at = row.at ? Date.parse(row.at) : Number.NaN;
    if (Number.isNaN(at)) continue;
    if (totals.lastCallAt === null || at > totals.lastCallAt) {
      totals.lastCallAt = at;
      totals.lastError = row.ok === false ? (row.error ?? 'failed') : null;
    }
    if (row.ok !== false && (totals.lastOkAt === null || at > totals.lastOkAt)) totals.lastOkAt = at;
    if (at < since) continue;
    totals.callsToday += 1;
    totals.durationTodayMs += typeof row.duration_ms === 'number' ? row.duration_ms
      : typeof row.duration_s === 'number' ? Math.round(row.duration_s * 1000) : 0;
  }
  return totals;
}

function runsFor(fleet: FleetState, account: string): RunState[] {
  return Object.values(fleet.runs).filter((run) => run.account === account);
}

export function buildAccountsBoard(input: AccountsBoardInput): Omit<AccountsResponse, 'registryPath' | 'registrySource' | 'registryError' | 'homeDir' | 'probe'> {
  const since = startOfLocalDay(input.now);
  const windowRows = input.fleet.events.filter((row) => row.event === 'account.window');
  const probeRows = input.fleet.events.filter((row) => row.event === 'account.probe');
  const codexTotals = foldCodexToday(input.codexLedgerLines, input.now);

  const accounts: AccountRow[] = input.accounts.map((account) => {
    const mine = windowRows.filter((row) => row['account'] === account.id);
    const probes = probeRows.filter((row) => row['account'] === account.id);
    const lastProbe = probes.at(-1);
    const lastWindowRow = mine.at(-1);
    const runs = runsFor(input.fleet, account.id);

    let connected: AccountRow['connected'] = 'unknown';
    let connectedReason: string | null = null;
    if (lastProbe) {
      connected = lastProbe['ok'] === true ? 'yes' : 'no';
      if (connected === 'no') connectedReason = typeof lastProbe['error'] === 'string' ? lastProbe['error'] : 'the probe failed';
    } else if (mine.some((row) => row.actor === 'worker')) {
      connected = 'yes';
    }
    if (account.provider === 'codex') {
      // The ledger cannot tell a login failure from any other failed call, so a Codex
      // row is connected once any call has ever answered and unknown before that; it
      // is never `no`. The last error is shown on the card in its own words.
      connected = codexTotals.lastOkAt === null ? 'unknown' : 'yes';
      connectedReason = null;
    }

    const fiveHour = foldWindow(mine.filter((row) => row['window'] === 'five_hour'));
    const sevenDay = foldWindow(mine.filter((row) => row['window'] === 'seven_day'));

    let paused: AccountRow['paused'] = null;
    if (lastWindowRow && lastWindowRow['status'] === 'rejected') {
      const until = typeof lastWindowRow['resetsAt'] === 'number' ? lastWindowRow['resetsAt'] : null;
      if (until !== null && until > input.now) {
        paused = { until, window: typeof lastWindowRow['window'] === 'string' ? lastWindowRow['window'] : 'unknown' };
      }
    }

    const subscriptionRow = [...probes].reverse().find((row) => typeof row['subscription'] === 'string');

    return {
      id: account.id,
      provider: account.provider,
      configDir: account.provider === 'claude' ? account.configDir : null,
      maxConcurrent: account.provider === 'claude' && typeof account.maxConcurrent === 'number' ? account.maxConcurrent : null,
      connected,
      connectedReason,
      subscription: subscriptionRow ? subscriptionRow['subscription'] as string : null,
      fiveHour,
      sevenDay,
      tokensToday: runs.filter((run) => run.lastEventAt >= since).reduce((sum, run) => sum + run.tokensUsed, 0),
      liveRuns: runs.filter((run) => run.state === 'started').length,
      lastEvent: lastWindowRow ? {
        at: lastWindowRow.at,
        window: typeof lastWindowRow['window'] === 'string' ? lastWindowRow['window'] : null,
        status: typeof lastWindowRow['status'] === 'string' ? lastWindowRow['status'] : 'unknown',
        actor: lastWindowRow.actor,
      } : null,
      paused,
      isLaunchAccount: account.id === input.launchAccount,
      codex: account.provider === 'codex' ? codexTotals : null,
    };
  });

  const unattributedTokensToday = Object.values(input.fleet.runs)
    .filter((run) => !run.account && run.lastEventAt >= since)
    .reduce((sum, run) => sum + run.tokensUsed, 0);

  return { accounts, unattributedTokensToday, checkedAt: input.now };
}
