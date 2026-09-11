import { afterEach, describe, expect, test, vi } from 'vitest';

import { scheduleAccountsProbeTick, syncAccounts } from '../../../../src/forge/sync/pages/accounts.js';

describe('syncAccounts', () => {
  test('two rows, one with readError: ok:1 failed:1, message names the id, refreshAll awaited before list()', async () => {
    const order: string[] = [];
    const deps = {
      refreshAll: async () => {
        order.push('refreshAll');
      },
      list: () => {
        order.push('list');
        return [
          { id: 'acct-good' },
          { id: 'acct-bad', readError: 'timeout' },
        ];
      },
    };

    const result = await syncAccounts(deps);

    expect(order).toEqual(['refreshAll', 'list']);
    expect(result.counts.probed).toBe(2);
    expect(result.counts.ok).toBe(1);
    expect(result.counts.failed).toBe(1);
    expect(result.message).toContain('acct-bad');
  });

  test('all rows ok: failed:0 and message names nothing', async () => {
    const deps = {
      refreshAll: async () => {},
      list: () => [{ id: 'acct-good' }],
    };

    const result = await syncAccounts(deps);

    expect(result.counts.probed).toBe(1);
    expect(result.counts.ok).toBe(1);
    expect(result.counts.failed).toBe(0);
  });
});

describe('scheduleAccountsProbeTick', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('fires once at 600s under fake time and appends exactly one accounts.probed row', async () => {
    vi.useFakeTimers();
    const rows: Array<Record<string, unknown>> = [];
    const journal = { append: (row: Record<string, unknown>) => { rows.push(row); return row; } };
    const accounts = {
      refreshAll: async () => {},
      list: () => [{ id: 'acct-good' }, { id: 'acct-bad', readError: 'timeout' }],
    };

    scheduleAccountsProbeTick({ seconds: 600, accounts, journal });

    await vi.advanceTimersByTimeAsync(600_000);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'accounts.probed', actor: 'sync', ok: 1, failed: 1 });
  });
});
