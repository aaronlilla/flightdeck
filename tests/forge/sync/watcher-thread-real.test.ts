/**
 * R-101: the real thread, end to end. `scripts/check-watcher-thread.ts` serves a fake Jira,
 * lets a ticket appear, and holds its main thread for 4 s. On the production wiring the
 * ticket's queue row must be written inside 2.5 s anyway; on the old in-process wiring it
 * cannot be, which is what proves the check detects the stall it exists for.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const script = join(__dirname, '..', '..', '..', 'scripts', 'check-watcher-thread.ts');

function runCheck(mode: 'thread' | 'inline'): { status: number | null; result: Record<string, unknown> | null; output: string } {
  const run = spawnSync(process.execPath, ['--import', 'tsx', script, mode], { encoding: 'utf8', timeout: 60_000 });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const line = (run.stdout ?? '').trim().split('\n').filter((row) => row.startsWith('{')).pop();
  return { status: run.status, result: line ? JSON.parse(line) as Record<string, unknown> : null, output };
}

describe('watcher thread under a held main thread', () => {
  it('writes the new ticket to the queue during the hold', () => {
    const { status, result, output } = runCheck('thread');
    expect(result, output).not.toBeNull();
    expect(result!['ok'], output).toBe(true);
    expect(status).toBe(0);
  }, 70_000);

  it('the in-process wiring misses the budget, so the check can fail', () => {
    const { status, result, output } = runCheck('inline');
    expect(result, output).not.toBeNull();
    expect(result!['ok'], output).toBe(false);
    expect(status).toBe(1);
  }, 70_000);
});
