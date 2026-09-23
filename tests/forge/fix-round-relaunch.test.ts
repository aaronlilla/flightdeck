/**
 * A FIX FIRST review relaunches the worker on its own branch with the findings in its
 * brief. On 2026-09-23 the queue's fix-round loop existed but nothing wired the relaunch,
 * so BBZ-386's PR #219 parked on its first FIX FIRST instead of being fixed.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { fixRoundRelauncher } from '../../src/forge/queue-wire.js';
import type { QueueItem } from '../../src/shared/console-model.js';

function item(briefPath: string, over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'Q-1', source: 'ticket', input: 'BBZ-1', ticket: 'BBZ-1', repo: 'owner/name',
    briefPath, branch: 'feature/bbz-1', worktreePath: 'C:/wt/bbz-1', base: 'develop',
    state: 'review', reason: null, runKey: 'queue-BBZ-1-Q-1', journalIds: [], createdAt: 1, updatedAt: 1,
    ...over,
  } as unknown as QueueItem;
}

describe('fixRoundRelauncher', () => {
  it('appends the findings to the brief and relaunches on the same branch and worktree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fix-round-'));
    const brief = join(dir, 'queue-BBZ-1.md');
    writeFileSync(brief, '# BBZ-1\n\nOriginal brief.\n', 'utf8');
    const launch = vi.fn(async () => ({ runKey: 'queue-BBZ-1-Q-1' }));

    const result = await fixRoundRelauncher({ launch })({ item: item(brief), findings: '1. button test never fails on the old code' });

    expect(result.runKey).toBe('queue-BBZ-1-Q-1');
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ branch: 'feature/bbz-1', worktreePath: 'C:/wt/bbz-1', briefPath: brief }));
    const text = readFileSync(brief, 'utf8');
    expect(text).toContain('Original brief.');
    expect(text).toContain('## Fix round 1');
    expect(text).toContain('button test never fails on the old code');
  });

  it('numbers the round from fixRoundsUsed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fix-round-'));
    const brief = join(dir, 'b.md');
    writeFileSync(brief, 'x\n', 'utf8');
    await fixRoundRelauncher({ launch: async () => ({ runKey: 'k' }) })({ item: item(brief, { fixRoundsUsed: 2 } as never), findings: 'f' });
    expect(readFileSync(brief, 'utf8')).toContain('## Fix round 3');
  });

  it('refuses without a worktree rather than launching somewhere else', async () => {
    const launch = vi.fn(async () => ({ runKey: 'k' }));
    await expect(fixRoundRelauncher({ launch })({ item: item('b.md', { worktreePath: null } as never), findings: 'f' })).rejects.toThrow(/worktree/);
    expect(launch).not.toHaveBeenCalled();
  });
});
