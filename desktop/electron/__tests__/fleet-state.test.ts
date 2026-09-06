import { describe, it, expect } from 'vitest';
import { hasLiveRun } from '../fleet-state';

describe('hasLiveRun', () => {
  it('is false with no lanes', () => {
    expect(hasLiveRun({ lanes: { value: [] } })).toBe(false);
  });

  it('is false with no lanes field at all', () => {
    expect(hasLiveRun({})).toBe(false);
  });

  it('is false when every lane is terminal', () => {
    expect(hasLiveRun({ lanes: { value: [{ run_state: 'done' }, { run_state: 'failed' }, { run_state: 'killed' }] } })).toBe(false);
  });

  it('is true when a lane is running', () => {
    expect(hasLiveRun({ lanes: { value: [{ run_state: 'done' }, { run_state: 'running' }] } })).toBe(true);
  });

  it('is true when a lane is only parked, since parked work still holds the fleet', () => {
    expect(hasLiveRun({ lanes: { value: [{ run_state: 'parked' }] } })).toBe(true);
  });
});
