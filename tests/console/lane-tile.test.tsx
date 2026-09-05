// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LaneTile } from '../../src/console/components/LaneTile.js';
import { laneBlocked } from '../../src/console/fixtures/state.js';

afterEach(() => {
  cleanup();
});

const noopSend = vi.fn().mockResolvedValue(undefined);
const noopClear = vi.fn().mockResolvedValue(undefined);

describe('LaneTile', () => {
  // X1: the falsifier named in the brief is "the tile still reads lane.verdict first".
  // `laneBlocked` carries `column: 'blocked'` with no verdict of its own; overlaying a
  // live `run_state: 'started'` (the shape server.ts now merges onto every lane) must
  // render "running", never "blocked".
  it('X1: a live run_state overrides the lane\'s own column/verdict', () => {
    const lane = { ...laneBlocked, run_state: 'started' as const };
    render(<LaneTile lane={lane} onSend={noopSend} onClear={noopClear} />);
    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.queryByText('blocked')).toBeNull();
  });

  it('X1: a className that only the live run carries still renders on the tile', () => {
    const lane = { ...laneBlocked, className: 'implement-hard', run_state: undefined };
    render(<LaneTile lane={lane} onSend={noopSend} onClear={noopClear} />);
    const tile = document.querySelector('[data-lane="withdrawal-fee"]')!;
    expect(tile.textContent).toContain('implement-hard');
  });

  it('falls back to the lane\'s own verdict once a run has finished (no run_state)', () => {
    const lane = { ...laneBlocked, column: 'done', verdict: 'failed', run_state: undefined };
    render(<LaneTile lane={lane} onSend={noopSend} onClear={noopClear} />);
    expect(screen.getByText('failed')).toBeTruthy();
  });
});
