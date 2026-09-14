/**
 * Live escape 2026-09-14: every claude process on the machine whose command line carries
 * `--output-format` classified as a fleet worker and was stamped with ONE shared mtime --
 * the newest file in the fleet sessions dir, 38 hours old -- so every OTHER session's
 * subagent tripped `stale-session` on each warden tick, different pids each time, and the
 * fleet-health board showed a permanent parade of false STUCK rows. A worker pid the
 * fleet's registry does not own must not be handed a staleness marker at all.
 */
import { describe, expect, it } from 'vitest';

import { watchedProcesses } from '../../src/forge/fleetwatch.js';

const WORKER_LINE = (pid: number): string =>
  `  ${pid} claude.exe --output-format stream-json --print`;

describe('watchedProcesses with an owned-pid set', () => {
  it('a worker pid the fleet does not own gets no session mtime and is marked foreign', () => {
    const result = watchedProcesses(
      { ok: true, lines: [WORKER_LINE(111), WORKER_LINE(222)] },
      new Set([111]),
    );
    expect(Array.isArray(result)).toBe(true);
    const procs = result as Exclude<typeof result, { ok: false; reason: string }>;
    const owned = procs.find((proc) => proc.pid === 111)!;
    const unowned = procs.find((proc) => proc.pid === 222)!;
    expect(unowned.kind).toBe('worker');
    expect(unowned.sessionFileMtime).toBeUndefined();
    expect(unowned.foreign).toBe(true);
    expect(owned.foreign).toBeUndefined();
  });

  it('with no owned-pid set, behavior is unchanged: every worker is watched', () => {
    const result = watchedProcesses({ ok: true, lines: [WORKER_LINE(333)] });
    const procs = result as Exclude<typeof result, { ok: false; reason: string }>;
    expect(procs[0]!.kind).toBe('worker');
    expect(procs[0]!.foreign).toBeUndefined();
  });
});
