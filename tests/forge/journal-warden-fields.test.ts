/**
 * P4.7/I2: the fields the Warden tick needs off a replayed run that `journal.ts` did not
 * carry before this integration -- cumulative cache-read ratio and turns since the last
 * write-shaped tool call, both computed as a pure fold over the same event stream every
 * other `RunState` field already comes from.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { Journal, replay, type ForgeEvent } from '../../src/forge/journal.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-journal-warden-'));
  path = join(dir, 'fleet.jsonl');
});

function write(...rows: Partial<ForgeEvent>[]): void {
  const journal = new Journal(path);
  for (const row of rows) journal.append(row as ForgeEvent);
  journal.close();
}

describe('cache-read totals, folded per run', () => {
  it('sums cacheRead and input across every usage row for the run', () => {
    write(
      { event: 'run.started', run: 'r1', actor: 'runner', model: 'sonnet' },
      { event: 'turn.end', run: 'r1', actor: 'worker', model: 'sonnet', usage: { input: 100, cacheRead: 900, cacheCreation: 0, output: 10 } },
      { event: 'turn.end', run: 'r1', actor: 'worker', model: 'sonnet', usage: { input: 50, cacheRead: 950, cacheCreation: 0, output: 10 } },
    );
    const state = replay(path);
    expect(state.runs['r1']!.cacheReadTokens).toBe(1850);
    expect(state.runs['r1']!.totalReadTokens).toBe(2000);
  });

  it('a run with no usage rows reads as zero, not undefined', () => {
    write({ event: 'run.started', run: 'r1', actor: 'runner' });
    const state = replay(path);
    expect(state.runs['r1']!.cacheReadTokens).toBe(0);
    expect(state.runs['r1']!.totalReadTokens).toBe(0);
  });
});

describe('turnsSinceWrite, folded per run', () => {
  it('counts turns since the last Edit/Write/NotebookEdit tool call', () => {
    write(
      { event: 'run.started', run: 'r1', actor: 'runner' },
      { event: 'tool.start', run: 'r1', actor: 'worker', tool: 'Edit' },
      { event: 'tool.end', run: 'r1', actor: 'worker', tool: 'Edit' },
      { event: 'turn.end', run: 'r1', actor: 'worker' },
      { event: 'tool.start', run: 'r1', actor: 'worker', tool: 'Read' },
      { event: 'tool.end', run: 'r1', actor: 'worker', tool: 'Read' },
      { event: 'turn.end', run: 'r1', actor: 'worker' },
      { event: 'tool.start', run: 'r1', actor: 'worker', tool: 'Bash' },
      { event: 'tool.end', run: 'r1', actor: 'worker', tool: 'Bash' },
      { event: 'turn.end', run: 'r1', actor: 'worker' },
    );
    const state = replay(path);
    // A write on turn 1 resets the counter to 0 for that turn; the two turns after it
    // (Read, then Bash, neither a write-shaped call) each add one.
    expect(state.runs['r1']!.turnsSinceWrite).toBe(2);
  });

  it('a run that has never taken a turn reads turnsSinceWrite as zero', () => {
    write({ event: 'run.started', run: 'r1', actor: 'runner' });
    const state = replay(path);
    expect(state.runs['r1']!.turnsSinceWrite).toBe(0);
  });
});
