import { describe, expect, test } from 'vitest';

import { syncLanes } from '../../../../src/forge/sync/pages/lanes.js';

describe('syncLanes', () => {
  test('three lanes, one changed, one throws: changed:1 failed:1', async () => {
    const deps = {
      lanes: () => [{ id: 'lane-a' }, { id: 'lane-b' }, { id: 'lane-c' }],
      recheck: async (id: string) => {
        if (id === 'lane-a') return true;
        if (id === 'lane-b') return false;
        throw new Error('gh error');
      },
    };

    const result = await syncLanes(deps);

    expect(result.counts.lanes).toBe(3);
    expect(result.counts.changed).toBe(1);
    expect(result.counts.failed).toBe(1);
  });

  test('rechecks sequentially: the third lane starts only after the second resolves', async () => {
    const events: string[] = [];
    const deps = {
      lanes: () => [{ id: 'lane-a' }, { id: 'lane-b' }, { id: 'lane-c' }],
      recheck: async (id: string) => {
        events.push(`start:${id}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`resolve:${id}`);
        return true;
      },
    };

    await syncLanes(deps);

    const thirdStart = events.indexOf('start:lane-c');
    const secondResolve = events.indexOf('resolve:lane-b');
    expect(thirdStart).toBeGreaterThan(-1);
    expect(secondResolve).toBeGreaterThan(-1);
    expect(thirdStart).toBeGreaterThan(secondResolve);
  });
});
