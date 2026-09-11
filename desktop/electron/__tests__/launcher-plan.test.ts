import { describe, it, expect } from 'vitest';
import { launcherPreCheck } from '../launcher-plan';

describe('launcherPreCheck', () => {
  it('a fake healthy server makes the pre-check a no-op: skip, not build-and-start', () => {
    const result = launcherPreCheck({ ok: true });
    expect(result.action).toBe('skip');
  });

  it('an unhealthy (or unreachable) server proceeds to build-and-start', () => {
    const result = launcherPreCheck({ ok: false });
    expect(result.action).toBe('build-and-start');
  });
});
