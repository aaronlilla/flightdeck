import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildCodeSyncDeps } from '../../../../src/forge/sync/code/real-deps.ts';

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('buildCodeSyncDeps', () => {
  it('builds git and gh on the exact argv execRun would receive', async () => {
    const calls: Array<{ argv: string[]; cwd?: string }> = [];
    const fakeExecRun = async (request: { argv: string[]; cwd?: string }) => {
      calls.push({ argv: request.argv, cwd: request.cwd });
      return { ok: true, tail: 'stdout-tail', startedAt: 0, durationMs: 0 };
    };

    const deps = buildCodeSyncDeps(
      { FORGE_REPO_CHECKOUTS: 'aaronlilla/flightdeck=D:/work/flightdeck', FORGE_REPO_BASE: 'aaronlilla/flightdeck=main' },
      { execRun: fakeExecRun as never },
    );

    await deps.git('D:/work/flightdeck', ['fetch', '--quiet', 'origin', 'main']);
    await deps.gh(['pr', 'list', '--repo', 'aaronlilla/flightdeck', '--head', 'feature/x'], 'D:/work/flightdeck');

    expect(calls[0]?.argv).toEqual(['git', 'fetch', '--quiet', 'origin', 'main']);
    expect(calls[0]?.cwd).toBe('D:/work/flightdeck');
    expect(calls[1]?.argv).toEqual(['gh', 'pr', 'list', '--repo', 'aaronlilla/flightdeck', '--head', 'feature/x']);
    expect(calls[1]?.cwd).toBe('D:/work/flightdeck');

    expect(deps.repos).toEqual([{ repo: 'aaronlilla/flightdeck', checkout: 'D:/work/flightdeck', base: 'main' }]);
  });

  it('claimedPaths returns only the fresh-heartbeat claim from a temp sessions dir', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'resync-sessions-'));
    const now = Date.now();
    const freshHeartbeatSec = Math.floor(now / 1000) - 60; // 1 minute ago
    const staleHeartbeatSec = Math.floor(now / 1000) - 20 * 60; // 20 minutes ago

    writeFileSync(
      join(tmpDir, 'fresh.json'),
      JSON.stringify({ heartbeatAt: freshHeartbeatSec, claims: [{ path: 'D:/work/worktrees/flightdeck--fresh' }] }),
    );
    writeFileSync(
      join(tmpDir, 'stale.json'),
      JSON.stringify({ heartbeatAt: staleHeartbeatSec, claims: [{ path: 'D:/work/worktrees/flightdeck--stale' }] }),
    );

    const deps = buildCodeSyncDeps({}, { sessionsDir: tmpDir });

    expect(deps.claimedPaths()).toEqual(['D:/work/worktrees/flightdeck--fresh']);
  });
});
