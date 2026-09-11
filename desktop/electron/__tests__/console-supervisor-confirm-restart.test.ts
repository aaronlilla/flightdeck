import { describe, it, expect, vi } from 'vitest';
import { proposeConfirmRestart, confirmRestart, type ConfirmRestartDeps } from '../console-supervisor';

describe('confirm-restart: the one kill this goal adds', () => {
  it('spawns and kills nothing on propose alone', async () => {
    const killPidOnly = vi.fn(async () => {});
    const result = await proposeConfirmRestart(4242, { liveDescendantPids: async () => [] });
    expect(result.kind).toBe('proposed');
    expect(killPidOnly).not.toHaveBeenCalled();
  });

  it('refuses to propose when a live run descends from the console pid', async () => {
    const result = await proposeConfirmRestart(4242, { liveDescendantPids: async () => [9999] });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') {
      expect(result.reason).toContain('9999');
      expect(result.reason).toContain('4242');
    }
  });

  it('kills only after confirmRestart is called with the token', async () => {
    const killPidOnly = vi.fn(async () => {});
    const deps: ConfirmRestartDeps = { liveDescendantPids: async () => [], killPidOnly };
    const proposed = await proposeConfirmRestart(4242, deps);
    expect(proposed.kind).toBe('proposed');
    if (proposed.kind !== 'proposed') return;

    expect(killPidOnly).not.toHaveBeenCalled();
    const result = await confirmRestart(proposed.token, deps);
    expect(result.ok).toBe(true);
    expect(killPidOnly).toHaveBeenCalledTimes(1);
    expect(killPidOnly).toHaveBeenCalledWith(4242);
  });

  it('refuses confirmRestart with an unknown or already-used token, killing nothing', async () => {
    const killPidOnly = vi.fn(async () => {});
    const deps: ConfirmRestartDeps = { liveDescendantPids: async () => [], killPidOnly };
    const result = await confirmRestart('not-a-real-token', deps);
    expect(result.ok).toBe(false);
    expect(killPidOnly).not.toHaveBeenCalled();
  });

  it('re-checks the live-run refusal at confirm time, in case a run started after propose', async () => {
    let live: number[] = [];
    const killPidOnly = vi.fn(async () => {});
    const deps: ConfirmRestartDeps = { liveDescendantPids: async () => live, killPidOnly };
    const proposed = await proposeConfirmRestart(4242, deps);
    expect(proposed.kind).toBe('proposed');
    if (proposed.kind !== 'proposed') return;

    live = [5555];
    const result = await confirmRestart(proposed.token, deps);
    expect(result.ok).toBe(false);
    expect(killPidOnly).not.toHaveBeenCalled();
  });

  it('a token can only be spent once', async () => {
    const killPidOnly = vi.fn(async () => {});
    const deps: ConfirmRestartDeps = { liveDescendantPids: async () => [], killPidOnly };
    const proposed = await proposeConfirmRestart(4242, deps);
    if (proposed.kind !== 'proposed') throw new Error('expected proposed');

    await confirmRestart(proposed.token, deps);
    const second = await confirmRestart(proposed.token, deps);
    expect(second.ok).toBe(false);
    expect(killPidOnly).toHaveBeenCalledTimes(1);
  });
});
