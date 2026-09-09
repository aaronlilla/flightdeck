import type { AccountsResponse } from '../../shared/console-model.js';

/** A three-account fleet as the Accounts view shows it: one account near its five-hour
 *  limit, one paused on a rejected window, one never probed, and the Codex row. Every
 *  path is a placeholder; the stub never names a real directory. */
export function seedAccounts(now: number = Date.now()): AccountsResponse {
  const home = '/srv/operator';
  return {
    accounts: [
      {
        id: 'fleet', provider: 'claude', configDir: `${home}/.claude-fleet`, maxConcurrent: 4,
        connected: 'yes', connectedReason: null, subscription: 'max',
        fiveHour: { utilization: 82, resetsAt: now + 48 * 60_000, status: 'allowed_warning', observedAt: now - 90_000 },
        sevenDay: { utilization: 37, resetsAt: now + 3 * 86_400_000, status: 'allowed', observedAt: now - 4 * 60_000 },
        tokensToday: 9_412_000, liveRuns: 3,
        lastEvent: { at: now - 90_000, window: 'five_hour', status: 'allowed_warning', actor: 'worker' },
        paused: null, isLaunchAccount: true, codex: null,
      },
      {
        id: 'fleet-b', provider: 'claude', configDir: `${home}/.claude-fleet-b`, maxConcurrent: 4,
        connected: 'yes', connectedReason: null, subscription: 'max',
        fiveHour: { utilization: 100, resetsAt: now + 2 * 3_600_000, status: 'rejected', observedAt: now - 30_000 },
        sevenDay: { utilization: 64, resetsAt: now + 5 * 86_400_000, status: 'allowed', observedAt: now - 4 * 60_000 },
        tokensToday: 6_120_000, liveRuns: 1,
        lastEvent: { at: now - 30_000, window: 'five_hour', status: 'rejected', actor: 'worker' },
        paused: { until: now + 2 * 3_600_000, window: 'five_hour' }, isLaunchAccount: false, codex: null,
      },
      {
        id: 'fleet-c', provider: 'claude', configDir: `${home}/.claude-fleet-c`, maxConcurrent: null,
        connected: 'no', connectedReason: 'not logged in', subscription: null,
        fiveHour: { utilization: null, resetsAt: null, status: 'unknown', observedAt: null },
        sevenDay: { utilization: null, resetsAt: null, status: 'unknown', observedAt: null },
        tokensToday: 0, liveRuns: 0, lastEvent: null, paused: null, isLaunchAccount: false, codex: null,
      },
      {
        id: 'codex', provider: 'codex', configDir: null, maxConcurrent: null,
        connected: 'yes', connectedReason: null, subscription: null,
        fiveHour: { utilization: null, resetsAt: null, status: 'unknown', observedAt: null },
        sevenDay: { utilization: null, resetsAt: null, status: 'unknown', observedAt: null },
        tokensToday: 0, liveRuns: 0, lastEvent: null, paused: null, isLaunchAccount: false,
        codex: { callsToday: 7, durationTodayMs: 41 * 60_000, lastError: null, lastCallAt: now - 20 * 60_000, lastOkAt: now - 20 * 60_000 },
      },
    ],
    registryPath: `${home}/.forge/accounts.json`,
    registrySource: 'file',
    registryError: null,
    homeDir: home,
    probe: { on: true, everySeconds: 300, lastAt: now - 4 * 60_000 },
    unattributedTokensToday: 0,
    checkedAt: now,
  };
}
