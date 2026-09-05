// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { CommandBar } from '../../src/console/components/CommandBar.js';
import { fleetStateFixture, laneBlocked } from '../../src/console/fixtures/state.js';

afterEach(() => {
  cleanup();
});

describe('CommandBar counts (X5 genchi genbutsu finding)', () => {
  // A real seeded server (X5) showed a lane whose own tile read "running" (from a
  // live run_state) while the command bar's count still called it blocked, because
  // the count read lane.column directly and never looked at run_state. The bar and
  // the tile must agree.
  it('counts a lane with a live run_state as running even when its column is stale', () => {
    const liveLane = { ...laneBlocked, run_state: 'started' as const };
    render(
      <CommandBar
        state={{ ...fleetStateFixture, lanes: { value: [liveLane], verified_at: Date.now() } }}
        disabledReason={undefined}
        onStop={() => {}}
        stopping={false}
      />,
    );
    const runningChip = screen.getByText('running').closest('.stat-chip')!;
    expect(runningChip.querySelector('.stat-chip__value')!.textContent).toBe('1');
    const blockedChip = screen.getByText('blocked').closest('.stat-chip')!;
    expect(blockedChip.querySelector('.stat-chip__value')!.textContent).toBe('0');
  });

  it('counts a parked live run as blocked even when the lane column disagrees', () => {
    const parkedLane = { ...laneBlocked, column: 'in-progress', run_state: 'parked' as const };
    render(
      <CommandBar
        state={{ ...fleetStateFixture, lanes: { value: [parkedLane], verified_at: Date.now() } }}
        disabledReason={undefined}
        onStop={() => {}}
        stopping={false}
      />,
    );
    const blockedChip = screen.getByText('blocked').closest('.stat-chip')!;
    expect(blockedChip.querySelector('.stat-chip__value')!.textContent).toBe('1');
  });
});
