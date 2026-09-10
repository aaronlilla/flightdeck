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
});
