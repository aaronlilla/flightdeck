/**
 * Nothing cleans up what a dead run leaves running today. `sweepFinishedRun` has to get
 * the boundary exactly right in both directions: kill every real leftover under a
 * finished run, and never touch anything that traces back to the live console or a live
 * session, even a few process levels up -- a direct-parent-only check would miss that
 * (the "console-pid-as-grandparent" specimen below), which is the trap that ended 161
 * processes on 2026-09-08.
 */
import { describe, expect, it, vi } from 'vitest';

import { sweepFinishedRun, type ProcessRow } from '../../src/forge/sweep.js';

describe('sweepFinishedRun', () => {
  it('kills a cmd.exe and a node.exe left behind by a finished run, old enough to count', () => {
    const processes: ProcessRow[] = [
      { pid: 100, ppid: 1, name: 'forge-run-worker.exe', ageMs: 120_000 }, // the run itself
      { pid: 101, ppid: 100, name: 'cmd.exe', ageMs: 120_000 },
      { pid: 102, ppid: 101, name: 'node.exe', ageMs: 90_000 },
    ];
    const journal = { append: vi.fn() };
    const kill = vi.fn();
    sweepFinishedRun({
      processes, journal, kill, finishedRunPid: 100, consolePid: 1, liveSessionPids: [], minAgeMs: 60_000,
    });
    expect(kill).toHaveBeenCalledWith(101);
    expect(kill).toHaveBeenCalledWith(102);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(journal.append).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'orphan.found', pid: 101, name: 'cmd.exe', ageMs: 120_000 }),
    );
    // Privacy: never a command line, only name/pid/age.
    for (const call of journal.append.mock.calls) {
      expect(Object.keys(call[0] as object).sort()).toEqual(['ageMs', 'event', 'name', 'pid'].sort());
    }
  });

  it('never touches a process too young to count as an orphan', () => {
    const processes: ProcessRow[] = [
      { pid: 100, ppid: 1, name: 'worker.exe', ageMs: 999_999 },
      { pid: 101, ppid: 100, name: 'node.exe', ageMs: 5_000 },
    ];
    const kill = vi.fn();
    sweepFinishedRun({
      processes, journal: { append: vi.fn() }, kill, finishedRunPid: 100, consolePid: 1, liveSessionPids: [],
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it('leaves a deep descendant alone when a live session pid is its grandparent, not just its parent', () => {
    // 103's grandparent (101), not its direct parent (102), is a pid a live session now
    // owns -- a pid recycled after the finished run's own subtree was created. A check
    // that only compares the direct parent to the protected set would miss this and
    // kill a process the live session actually owns.
    const processes: ProcessRow[] = [
      { pid: 100, ppid: 0, name: 'forge-run-worker.exe', ageMs: 999_999 }, // finished run
      { pid: 101, ppid: 100, name: 'reused-by-live-session.exe', ageMs: 999_999 },
      { pid: 102, ppid: 101, name: 'cmd.exe', ageMs: 999_999 },
      { pid: 103, ppid: 102, name: 'node.exe', ageMs: 999_999 }, // the actual target
    ];
    const kill = vi.fn();
    sweepFinishedRun({
      processes, journal: { append: vi.fn() }, kill,
      finishedRunPid: 100, consolePid: 1, liveSessionPids: [101],
    });
    expect(kill).not.toHaveBeenCalledWith(103);
    expect(kill).not.toHaveBeenCalledWith(102);
    expect(kill).not.toHaveBeenCalledWith(101);
  });

  it('never kills a process under the live console pid even if its command line matches', () => {
    const processes: ProcessRow[] = [
      { pid: 1, ppid: 0, name: 'console.exe', ageMs: 999_999 },
      { pid: 2, ppid: 1, name: 'node.exe', ageMs: 999_999 }, // belongs to the live console
      { pid: 100, ppid: 0, name: 'finished-run.exe', ageMs: 999_999 },
    ];
    const kill = vi.fn();
    sweepFinishedRun({
      processes, journal: { append: vi.fn() }, kill, finishedRunPid: 100, consolePid: 1, liveSessionPids: [],
    });
    expect(kill).not.toHaveBeenCalledWith(2);
    expect(kill).not.toHaveBeenCalledWith(1);
  });

  it('never touches a process under a live run', () => {
    const processes: ProcessRow[] = [
      { pid: 100, ppid: 0, name: 'finished-run.exe', ageMs: 999_999 },
      { pid: 300, ppid: 0, name: 'live-run.exe', ageMs: 999_999 },
      { pid: 301, ppid: 300, name: 'node.exe', ageMs: 999_999 },
    ];
    const kill = vi.fn();
    sweepFinishedRun({
      processes, journal: { append: vi.fn() }, kill, finishedRunPid: 100, consolePid: 1, liveSessionPids: [300],
    });
    expect(kill).not.toHaveBeenCalledWith(301);
    expect(kill).not.toHaveBeenCalledWith(300);
  });

  it('kill is injected and every call is recorded, never a real taskkill in a test', () => {
    const processes: ProcessRow[] = [
      { pid: 100, ppid: 0, name: 'finished-run.exe', ageMs: 999_999 },
      { pid: 101, ppid: 100, name: 'node.exe', ageMs: 999_999 },
    ];
    const kill = vi.fn();
    sweepFinishedRun({ processes, journal: { append: vi.fn() }, kill, finishedRunPid: 100, consolePid: 1, liveSessionPids: [] });
    expect(kill.mock.calls).toEqual([[101]]);
  });
});
