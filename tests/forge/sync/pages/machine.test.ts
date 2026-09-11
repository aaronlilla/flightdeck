import { describe, expect, test, vi } from 'vitest';

import { syncMachine } from '../../../../src/forge/sync/pages/machine.js';

describe('syncMachine', () => {
  test('invokes the injected snapshot once per call and passes counts through unmodified', async () => {
    const snapshot = vi.fn(async () => ({ sessions: 3, processes: 11 }));

    const result = await syncMachine({ snapshot });
    const result2 = await syncMachine({ snapshot });

    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(result.counts).toEqual({ sessions: 3, processes: 11 });
    expect(result2.counts).toEqual({ sessions: 3, processes: 11 });
    expect(result.message).toMatch(/^read at .+, next automatic read in 10 s$/);
  });

  test('a throwing snapshot yields empty counts and a message, no throw', async () => {
    const snapshot = vi.fn(async () => {
      throw new Error('process table read failed');
    });

    const result = await syncMachine({ snapshot });

    expect(result.counts).toEqual({});
    expect(result.message).toContain('process table read failed');
  });
});
