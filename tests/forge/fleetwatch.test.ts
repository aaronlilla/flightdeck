/**
 * The real process-table reader, and what a failed read looks like downstream.
 *
 * A process probe can throw (PowerShell missing, `ps` unavailable, a timeout). Before
 * this, that failure and a verified-empty machine both produced `[]`, so liveness's
 * stale-session signal could never tell "nothing running" from "the sensor is broken."
 */
import { describe, expect, it } from 'vitest';

import { watchedProcesses } from '../../src/forge/fleetwatch.js';

describe('watchedProcesses, given an injected probe', () => {
  it('reads real claude processes from a successful probe', () => {
    const result = watchedProcesses({
      ok: true,
      lines: ['111 claude --some-flag', '222 claude login', '333 unrelated-process'],
    });
    expect(Array.isArray(result)).toBe(true);
    const processes = result as Array<{ pid: number; isLogin: boolean }>;
    expect(processes.map((p) => p.pid).sort()).toEqual([111, 222]);
    expect(processes.find((p) => p.pid === 222)?.isLogin).toBe(true);
  });

  it('surfaces a failed probe as { ok: false, reason }, never an empty list', () => {
    const result = watchedProcesses({ ok: false, reason: 'powershell timed out' });
    expect(Array.isArray(result)).toBe(false);
    expect(result).toEqual({ ok: false, reason: 'powershell timed out' });
  });
});
