import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { scanSessions, resetGitInfoCache } from '../../../src/forge/sessions/registry.js';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'registry-test-'));
}

function writeSession(configDir: string, id: string, record: Record<string, unknown>): void {
  const sessionsDir = join(configDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, `${id}.json`), JSON.stringify(record));
}

const cleanupDirs: string[] = [];

afterEach(() => {
  resetGitInfoCache();
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('scanSessions', () => {
  it('reads every config dir, including one only the accounts registry names, and marks a dead pid vanished', () => {
    const homeDir = makeDir();
    const fleetDir = makeDir();
    const thirdAccountDir = makeDir();
    const accountsRegistryDir = makeDir();
    cleanupDirs.push(homeDir, fleetDir, thirdAccountDir, accountsRegistryDir);

    writeSession(homeDir, 'sess-home', {
      sessionId: 'sess-home', pid: 111, procStart: '1000', cwd: '/repos/somewhere',
      kind: 'interactive', name: 'dev-home', status: 'idle',
      startedAt: 1, statusUpdatedAt: 1,
    });
    writeSession(fleetDir, 'sess-fleet', {
      sessionId: 'sess-fleet', pid: 222, procStart: '2000', cwd: '/repos/worker',
      kind: 'interactive', name: 'worker-1', status: 'busy',
      startedAt: 2, statusUpdatedAt: 2,
    });
    writeSession(thirdAccountDir, 'sess-third', {
      sessionId: 'sess-third', pid: 333, procStart: '3000', cwd: '/repos/third',
      kind: 'interactive', name: 'account-b', status: 'idle',
      startedAt: 3, statusUpdatedAt: 3,
    });
    writeSession(fleetDir, 'sess-dead', {
      sessionId: 'sess-dead', pid: 444, procStart: '4000', cwd: '/repos/dead',
      kind: 'interactive', name: 'dead-one', status: 'idle',
      startedAt: 4, statusUpdatedAt: 4,
    });

    const accountsRegistryPath = join(accountsRegistryDir, 'registry.json');
    writeFileSync(accountsRegistryPath, JSON.stringify({
      accounts: [
        { id: 'acct-b', provider: 'claude', label: 'account-b', configDir: thirdAccountDir, connectedAt: 0 },
        { id: 'acct-codex', provider: 'codex', label: 'codex-account', configDir: join(accountsRegistryDir, 'codex-should-be-ignored'), connectedAt: 0 },
      ],
    }));

    const alive = new Map<number, string>([[111, '1000'], [222, '2000'], [333, '3000']]);

    const rows = scanSessions({
      fixedConfigDirs: () => [
        { dir: homeDir, accountLabel: 'default' },
        { dir: fleetDir, accountLabel: 'fleet' },
      ],
      accountsRegistryPath,
      probeAlivePid: (pid) => alive.get(pid) ?? null,
      gitInfo: () => ({ repo: null, worktree: null, branch: null }),
    });

    expect(rows).toHaveLength(4);

    const byId = new Map(rows.map((row) => [row.sessionId, row]));

    expect(byId.get('sess-home')?.vanished).toBeUndefined();
    expect(byId.get('sess-fleet')?.vanished).toBeUndefined();

    const thirdRow = byId.get('sess-third');
    expect(thirdRow).toBeDefined();
    expect(thirdRow?.configDir).toBe(thirdAccountDir);
    expect(thirdRow?.vanished).toBeUndefined();

    const deadRow = byId.get('sess-dead');
    expect(deadRow?.vanished).toBe(true);

    // The codex-provider entry must never contribute a config dir.
    expect(rows.some((row) => row.configDir.includes('codex-should-be-ignored'))).toBe(false);
  });

  // Escape 2026-09-10: the real probe in `cli.ts` answered "alive" with a sentinel, not
  // the pid's procStart, and `scanSessions` compared that sentinel to the record's
  // `procStart`. They never matched, so every live session was journaled `session.vanished`
  // on every 30 s tick (616 vanished rows against 27 started in ~/.forge/fleet.jsonl; the
  // Machine page attached zero of 109 processes). A liveness-only probe says `true` and
  // must not be held to a procStart match it never claimed to make.
  it('does not mark a live session vanished when the probe can only answer liveness (true)', () => {
    const homeDir = makeDir();
    cleanupDirs.push(homeDir);
    writeSession(homeDir, 'sess-live', {
      sessionId: 'sess-live', pid: 555, procStart: '134335653731609231', cwd: '/repos/live',
      kind: 'interactive', name: 'dev-live', status: 'busy', startedAt: 5, statusUpdatedAt: 5,
    });
    writeSession(homeDir, 'sess-gone', {
      sessionId: 'sess-gone', pid: 556, procStart: '134335653731609999', cwd: '/repos/gone',
      kind: 'interactive', name: 'dev-gone', status: 'idle', startedAt: 6, statusUpdatedAt: 6,
    });

    const rows = scanSessions({
      fixedConfigDirs: () => [{ dir: homeDir, accountLabel: 'default' }],
      accountsRegistryPath: join(homeDir, 'no-registry.json'),
      probeAlivePid: (pid) => (pid === 555 ? true : undefined),
      gitInfo: () => ({ repo: null, worktree: null, branch: null }),
    });
    const byId = new Map(rows.map((row) => [row.sessionId, row]));
    expect(byId.get('sess-live')?.vanished).toBeUndefined();
    expect(byId.get('sess-gone')?.vanished).toBe(true);
  });

  it('still marks a recycled pid vanished when the probe does return a procStart that differs', () => {
    const homeDir = makeDir();
    cleanupDirs.push(homeDir);
    writeSession(homeDir, 'sess-recycled', {
      sessionId: 'sess-recycled', pid: 777, procStart: '1000', cwd: '/repos/recycled',
      kind: 'interactive', name: 'dev-recycled', status: 'idle', startedAt: 7, statusUpdatedAt: 7,
    });
    const rows = scanSessions({
      fixedConfigDirs: () => [{ dir: homeDir, accountLabel: 'default' }],
      accountsRegistryPath: join(homeDir, 'no-registry.json'),
      probeAlivePid: () => '2000',
      gitInfo: () => ({ repo: null, worktree: null, branch: null }),
    });
    expect(rows[0]?.vanished).toBe(true);
  });
});

describe('probeAlivePidLiveness', () => {
  it('answers true for this process and undefined for a pid that cannot exist', async () => {
    const { probeAlivePidLiveness } = await import('../../../src/forge/sessions/registry.js');
    expect(probeAlivePidLiveness(process.pid)).toBe(true);
    expect(probeAlivePidLiveness(2 ** 22 + 12345)).toBeUndefined();
  });
});
