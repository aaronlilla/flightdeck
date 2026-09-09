import { describe, expect, it } from 'vitest';
import { accountsLine } from '../accounts-line';

describe('accountsLine', () => {
  it('says none when no Claude account is registered', () => {
    expect(accountsLine({})).toBe('Accounts: none registered.');
    expect(accountsLine({ accounts: [{ id: 'codex', provider: 'codex' }] })).toBe('Accounts: none registered.');
  });

  it('counts connected accounts and names each one with its five-hour reading', () => {
    const line = accountsLine({
      accounts: [
        { id: 'fleet', provider: 'claude', connected: 'yes', liveRuns: 2, paused: null, fiveHour: { utilization: 41.6 } },
        { id: 'fleet-b', provider: 'claude', connected: 'yes', liveRuns: 0, paused: { until: 1 }, fiveHour: { utilization: 100 } },
        { id: 'fleet-c', provider: 'claude', connected: 'no', liveRuns: 0, paused: null, fiveHour: { utilization: null } },
        { id: 'fleet-d', provider: 'claude', connected: 'unknown', liveRuns: 0, paused: null, fiveHour: null },
        { id: 'codex', provider: 'codex', connected: 'yes' },
      ],
    });
    expect(line).toBe('Accounts: 2 of 4 Claude connected (fleet 42% of five hours, 2 live; fleet-b paused; fleet-c not connected; fleet-d not checked).');
  });
});
