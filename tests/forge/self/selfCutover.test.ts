import { describe, expect, it, vi } from 'vitest';

import { cutoverDue, type CutoverCheckoutGit } from '../../../src/forge/self/selfCutover.js';

function git(remoteHead: string, overrides: Partial<CutoverCheckoutGit> = {}): CutoverCheckoutGit {
  return {
    fetch: vi.fn().mockResolvedValue(undefined),
    remoteHead: vi.fn().mockResolvedValue(remoteHead),
    pullFastForward: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('cutoverDue', () => {
  it('does nothing when origin/main matches the running head', async () => {
    const g = git('same-sha');
    const append = vi.fn();
    const result = await cutoverDue({
      checkout: 'C:/checkout', runningHead: 'same-sha', idle: () => true, git: g, append,
    });
    expect(result.restart).toBe(false);
    expect(g.pullFastForward).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('does not restart while the fleet is not idle, even if origin has moved', async () => {
    const g = git('new-sha');
    const result = await cutoverDue({
      checkout: 'C:/checkout', runningHead: 'old-sha', idle: () => false, git: g, append: vi.fn(),
    });
    expect(result.restart).toBe(false);
    expect(g.pullFastForward).not.toHaveBeenCalled();
  });

  it('pulls fast-forward and journals self.restart once origin has moved and the fleet is idle', async () => {
    const g = git('new-sha');
    const append = vi.fn();
    const result = await cutoverDue({
      checkout: 'C:/checkout', runningHead: 'old-sha', idle: () => true, git: g, append,
    });
    expect(result).toEqual({ restart: true, from: 'old-sha', to: 'new-sha' });
    expect(g.pullFastForward).toHaveBeenCalledWith('C:/checkout');
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'self.restart', from: 'old-sha', to: 'new-sha' }),
    );
  });

  it('always fetches before comparing, so a stale local ref never blocks a real move', async () => {
    const g = git('same-sha');
    await cutoverDue({ checkout: 'C:/checkout', runningHead: 'same-sha', idle: () => true, git: g, append: vi.fn() });
    expect(g.fetch).toHaveBeenCalledWith('C:/checkout');
  });
});
