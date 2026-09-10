import { describe, expect, it } from 'vitest';

import { buildMachineSnapshot, type MachineSessionInput } from '../../../src/forge/machine/snapshot.js';
import type { ProcessRow } from '../../../src/forge/sweep.js';

function row(overrides: Partial<ProcessRow> & Pick<ProcessRow, 'pid' | 'ppid' | 'name'>): ProcessRow {
  return { ageMs: 1000, ...overrides };
}

describe('buildMachineSnapshot', () => {
  const rows: ProcessRow[] = [
    // Session A's own claude process, with a nested python-under-node subtree.
    row({ pid: 100, ppid: 1, name: 'claude.exe' }),
    row({ pid: 101, ppid: 100, name: 'node.exe' }),
    row({ pid: 102, ppid: 101, name: 'python.exe', commandLine: 'python worker.py --token=abc123' }),
    // Session B's own claude process, no children.
    row({ pid: 200, ppid: 1, name: 'claude.exe' }),
    // A Codex root nothing claims.
    row({ pid: 300, ppid: 1, name: 'codex.exe' }),
    row({ pid: 301, ppid: 300, name: 'node.exe' }),
    // An orphan python root, unrelated to any session.
    row({ pid: 400, ppid: 1, name: 'python.exe', commandLine: 'python scrape.py https://user:hunter2@example.com/api' }),
    // Machine noise the join should never surface as a root.
    row({ pid: 500, ppid: 1, name: 'explorer.exe' }),
  ];

  const sessions: MachineSessionInput[] = [
    { sessionId: 's-a', pid: 100, name: 'session-a', repo: '/repos/flightdeck', branch: 'main', status: 'live' },
    { sessionId: 's-b', pid: 200, name: 'session-b', repo: '/repos/other', branch: 'develop', status: 'live' },
    // A dead session: pid 999 is not in the process table at all.
    { sessionId: 's-dead', pid: 999, name: 'session-dead', repo: '/repos/gone', branch: 'main', status: 'ended' },
  ];

  it('builds the session subtrees, the unregistered roots, the counts, and masks secrets', () => {
    const snapshot = buildMachineSnapshot(sessions, rows, 123456, { intervalMs: 5000 });

    const byId = new Map(snapshot.sessions.map((s) => [s.sessionId, s]));

    // Session A's subtree is nested: claude -> node -> python.
    const aRoot = byId.get('s-a')?.root;
    expect(aRoot?.pid).toBe(100);
    expect(aRoot?.children).toHaveLength(1);
    const node = aRoot?.children[0];
    expect(node?.pid).toBe(101);
    expect(node?.name).toBe('node.exe');
    expect(node?.children).toHaveLength(1);
    const python = node?.children[0];
    expect(python?.pid).toBe(102);
    expect(python?.output).toBe('not captured');

    // The token in the nested python's command line is masked.
    expect(python?.commandLine).toContain('[REDACTED]');
    expect(python?.commandLine).not.toContain('abc123');

    // Session B has a root with no children.
    expect(byId.get('s-b')?.root?.pid).toBe(200);
    expect(byId.get('s-b')?.root?.children).toHaveLength(0);

    // A dead session yields no subtree at all.
    expect(byId.get('s-dead')?.root).toBeNull();

    // Unregistered: the Codex root (with its nested node) and the orphan python root.
    expect(snapshot.unregistered).toHaveLength(2);
    const codexRoot = snapshot.unregistered.find((r) => r.name === 'codex.exe');
    expect(codexRoot?.children).toHaveLength(1);
    expect(codexRoot?.children[0]?.pid).toBe(301);
    const orphanPython = snapshot.unregistered.find((r) => r.pid === 400);
    expect(orphanPython).toBeDefined();

    // The credentialed URL in the orphan root's command line is masked.
    expect(orphanPython?.commandLine).toContain('[REDACTED]:[REDACTED]@');
    expect(orphanPython?.commandLine).not.toContain('hunter2');

    // explorer.exe is machine noise: it never becomes a root and is never counted.
    const allPids = new Set<number>();
    const collect = (n: typeof aRoot): void => {
      if (!n) return;
      allPids.add(n.pid);
      n.children.forEach(collect);
    };
    snapshot.sessions.forEach((s) => collect(s.root));
    snapshot.unregistered.forEach(collect);
    expect(allPids.has(500)).toBe(false);

    // Counts: 3 sessions, processes = 3 (session A subtree) + 1 (session B) + 2 (codex subtree) + 1 (orphan) = 7.
    expect(snapshot.counts.sessions).toBe(3);
    expect(snapshot.counts.processes).toBe(7);
    expect(snapshot.counts.unregistered).toBe(3);

    expect(snapshot.readAt).toBe(123456);
    expect(snapshot.intervalMs).toBe(5000);
  });

  it('does not drop a process whose ppid points at itself (a real Windows pid-reuse shape)', () => {
    // /critique, 2026-09-10: a self-referencing ppid was being read as "parent still
    // present" and the whole process silently vanished from the snapshot.
    const selfLoopRows: ProcessRow[] = [row({ pid: 600, ppid: 600, name: 'node.exe' })];
    const snapshot = buildMachineSnapshot([], selfLoopRows, 1);
    expect(snapshot.unregistered).toHaveLength(1);
    expect(snapshot.unregistered[0]?.pid).toBe(600);
    expect(snapshot.counts.unregistered).toBe(1);
  });

  it('never infinite-loops or throws on a two-node ppid cycle (nest()\'s own ancestor guard)', () => {
    // A pure two-node mutual cycle (each row's ppid names the other) has no anchor
    // reachable via `remainingPids.has(row.ppid)`'s escape test, so neither row is
    // promoted to root and the pair is dropped from `unregistered` -- a known,
    // documented residual gap (see snapshot.ts's comment above `nest()` and this
    // goal's `/critique` Status entry), accepted rather than fixed: real Windows
    // process tables cannot form a true ppid cycle between two live processes, so
    // this shape only exists as a synthetic malformed-input specimen. What this test
    // actually proves is the safety property that DOES matter: `nest()`'s own
    // ancestor-chain guard means feeding it a cyclic pool never hangs or overflows
    // the stack, even from a specimen that reaches `nest()` some other way.
    const cyclicRows: ProcessRow[] = [
      row({ pid: 700, ppid: 701, name: 'node.exe' }),
      row({ pid: 701, ppid: 700, name: 'node.exe' }),
    ];
    expect(() => buildMachineSnapshot([], cyclicRows, 1)).not.toThrow();
  });

  it('surfaces a claude/codex/node/python root even under a non-matching parent process', () => {
    // /code-review high, 2026-09-10: powershell.exe -> node.exe -> node.exe used to
    // vanish entirely, because the middle node's parent (powershell) being "still
    // present" was read as "belongs to that subtree" with no name check on the parent.
    const rowsUnderLauncher: ProcessRow[] = [
      row({ pid: 800, ppid: 1, name: 'powershell.exe' }),
      row({ pid: 801, ppid: 800, name: 'node.exe' }),
      row({ pid: 802, ppid: 801, name: 'node.exe' }),
    ];
    const snapshot = buildMachineSnapshot([], rowsUnderLauncher, 1);
    expect(snapshot.unregistered).toHaveLength(1);
    const root = snapshot.unregistered[0];
    expect(root?.pid).toBe(801);
    expect(root?.children).toHaveLength(1);
    expect(root?.children[0]?.pid).toBe(802);
    // powershell.exe itself never matches the pattern and is never counted.
    expect(snapshot.counts.unregistered).toBe(2);
  });

  it('counts a pid shared by two session records once, not once per session', () => {
    // /critique, 2026-09-10: a stale session record sharing a live pid with another
    // (a real Windows pid-reuse race) doubled `counts.processes` for that pid's subtree.
    const sharedRows: ProcessRow[] = [
      row({ pid: 100, ppid: 1, name: 'claude.exe' }),
      row({ pid: 101, ppid: 100, name: 'node.exe' }),
    ];
    const dup: MachineSessionInput[] = [
      { sessionId: 's-a', pid: 100, name: 'session-a' },
      { sessionId: 's-b', pid: 100, name: 'session-b' },
    ];
    const snapshot = buildMachineSnapshot(dup, sharedRows, 1);
    expect(snapshot.counts.sessions).toBe(2);
    expect(snapshot.counts.processes).toBe(2);
  });
});
