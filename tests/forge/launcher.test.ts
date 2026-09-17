/**
 * The launcher, and the version a worker is pinned to.
 *
 * Six goals were launched by hand on 2026-09-04 and four failed on one of the checks
 * below. Every one of them is the kind of mistake that produces a session which looks
 * like it started and then does nothing useful, which is the most expensive failure this
 * system has: it burns a tier and leaves no evidence.
 *
 *   the condition    a /goal block over 4,000 characters is silently truncated, so the
 *                    goal runs against half a condition and reports itself met.
 *   the config dir   pinned to the fleet's own, never inherited, or the worker writes
 *                    into the interactive session's store and a login in one place
 *                    changes what the other authenticates as.
 *   the environment  the nine inherited names, again, because this is where they matter.
 *   a login in flight  starting a worker while `claude login` is running races the
 *                    credential it is about to use.
 *   ws Monitors      a queued Monitor event kills a `-p` process mid tool call. A worker
 *                    has no console to watch anyway.
 *
 * The version pin is the other half. A worker records the Forge revision it started on
 * and keeps it; nothing hot-patches a running worker or a live machine's hooks partway.
 * The install.ps1 incident on 2026-09-04 is the specimen for why: a half-applied change
 * left a hook that crashed on every plan tool.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  CONDITION_LIMIT,
  checkLaunch,
  launchEnv,
  pinnedRuntime,
  runtimeCheckout,
  runtimeVersion,
} from '../../src/forge/launcher.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-launch-'));
  process.env['FORGE_HOME'] = home;
  delete process.env['FORGE_CONFIG_DIR'];
});

const OK = { brief: '# Goal\n\nDo the thing.\n', condition: 'Work the brief to completion.' };

function check(overrides: Record<string, unknown> = {}) {
  return checkLaunch({ ...OK, ...overrides } as never);
}

describe('the condition length check', () => {
  it('passes a condition inside the limit', () => {
    expect(check().ok).toBe(true);
  });

  it('has its limit at 4000, the number the platform truncates at', () => {
    // The literal, not the constant. A row written as CONDITION_LIMIT + 1 moves with the
    // constant, so it stays green however wrong the limit becomes: watched passing with
    // the limit set to 400000, which is the whole failure it was supposed to catch.
    expect(CONDITION_LIMIT).toBe(4000);
  });

  it('refuses one over 4000 characters rather than letting it be truncated', () => {
    const verdict = check({ condition: 'x'.repeat(4001) });
    expect(verdict.ok).toBe(false);
    expect(verdict.refusals.join(' ')).toMatch(/4000|condition/i);
  });

  it('passes one exactly at the limit', () => {
    expect(check({ condition: 'x'.repeat(CONDITION_LIMIT) }).ok).toBe(true);
  });

  it('refuses an empty condition, which is a goal with no way to end', () => {
    expect(check({ condition: '   ' }).ok).toBe(false);
  });
});

describe('a login in flight', () => {
  it('refuses to start while one is running', () => {
    const verdict = check({ loginRunning: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.refusals.join(' ')).toMatch(/login/i);
  });

  it('starts once the login has finished', () => {
    expect(check({ loginRunning: false }).ok).toBe(true);
  });
});

describe('the kill switch', () => {
  it('refuses to start while it is engaged, naming the reason', () => {
    const verdict = check({ killSwitch: { engaged: true, reason: 'stopped by hand' } });
    expect(verdict.ok).toBe(false);
    expect(verdict.refusals.join(' ')).toMatch(/kill switch/i);
    expect(verdict.refusals.join(' ')).toContain('stopped by hand');
  });

  it('starts once it is cleared', () => {
    expect(check({ killSwitch: { engaged: false } }).ok).toBe(true);
  });
});

describe('websocket monitors', () => {
  it('refuses a brief that tells a worker to open one', () => {
    const verdict = check({
      brief: '# Goal\n\nFirst open the slot feed with Monitor({ws:{url:"ws://127.0.0.1:4100"}}).\n',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.refusals.join(' ')).toMatch(/monitor/i);
  });

  it('leaves a brief that merely mentions websockets alone', () => {
    expect(check({ brief: '# Goal\n\nThe server serves an events websocket on 4120.\n' }).ok)
      .toBe(true);
  });
});

describe('the environment a launch builds', () => {
  it('pins CLAUDE_CONFIG_DIR to the fleet directory rather than inheriting one', () => {
    // No fleet login on this machine, injected: proves the pin, not the fleet-vs-forge
    // choice, which paths.test.ts covers on its own.
    const env = launchEnv({ CLAUDE_CONFIG_DIR: '/somewhere/aarons/own' }, () => false);
    expect(env['CLAUDE_CONFIG_DIR']).toContain(home);
    expect(env['CLAUDE_CONFIG_DIR']).not.toBe('/somewhere/aarons/own');
  });

  it('still strips the nine inherited names', () => {
    const env = launchEnv({ CLAUDECODE: '1', CLAUDE_PID: '9', PATH: '/usr/bin' });
    expect(env['CLAUDECODE']).toBeUndefined();
    expect(env['CLAUDE_PID']).toBeUndefined();
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('still unsets ANTHROPIC_API_KEY', () => {
    expect(launchEnv({ ANTHROPIC_API_KEY: 'sk-nope' })['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('records the runtime version the worker is pinned to', () => {
    expect(launchEnv({})['FORGE_RUNTIME']).toBe(runtimeVersion());
  });
});

describe('the version a worker is pinned to', () => {
  it('is recorded when the run starts', () => {
    const pin = pinnedRuntime('alpha');
    expect(pin.version).toBe(runtimeVersion());
    expect(readFileSync(join(home, 'runs', 'alpha', 'runtime.json'), 'utf8'))
      .toContain(runtimeVersion());
  });

  it('does not change under a running worker when the runtime moves on', () => {
    const first = pinnedRuntime('alpha');
    writeFileSync(
      join(home, 'runs', 'alpha', 'runtime.json'),
      JSON.stringify({ version: 'pinned-earlier', at: first.at }),
      'utf8',
    );
    expect(pinnedRuntime('alpha').version).toBe('pinned-earlier');
  });

  it('gives a new run the current version, not the one the last run pinned', () => {
    pinnedRuntime('alpha');
    writeFileSync(
      join(home, 'runs', 'alpha', 'runtime.json'),
      JSON.stringify({ version: 'pinned-earlier', at: 1 }),
      'utf8',
    );
    expect(pinnedRuntime('alpha').version).toBe('pinned-earlier');
    expect(pinnedRuntime('beta').version).toBe(runtimeVersion());
  });

  it('has a version at all, which is what makes the pin mean anything', () => {
    expect(runtimeVersion()).toMatch(/\S/);
  });

  it('B.3.9: pins flightdeck\'s own HEAD even when called from a foreign cwd', async () => {
    const { execFileSync } = await import('node:child_process');
    const flightdeckHead = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8', cwd: process.cwd(),
    }).trim();

    // A directory with no git repo of its own: if runtimeVersion() ran `git rev-parse`
    // in the caller's cwd instead of flightdeck's own source, it would find nothing here
    // and fall back to "unversioned" rather than flightdeck's real revision.
    const foreignCwd = mkdtempSync(join(tmpdir(), 'forge-foreign-cwd-'));
    const originalCwd = process.cwd();
    process.chdir(foreignCwd);
    let version: string;
    try {
      const { vi } = await import('vitest');
      vi.resetModules();
      const fresh = await import('../../src/forge/launcher.js');
      version = fresh.runtimeVersion();
    } finally {
      process.chdir(originalCwd);
    }

    expect(version).toBe(flightdeckHead);
    expect(version).not.toBe('unversioned');
  });
});

describe('what a refusal says', () => {
  it('names every reason, not just the first', () => {
    const verdict = check({
      condition: '', loginRunning: true,
      brief: 'Open Monitor({ws:{url:"ws://x"}}) first.',
    });
    expect(verdict.refusals.length).toBeGreaterThanOrEqual(3);
  });

  it('is quiet when there is nothing to refuse', () => {
    expect(check().refusals).toEqual([]);
  });
});

/**
 * A start says which checkout it is serving. Before this, the banner carried a version
 * and a port only, so a console on a stale tree read identically to one on the trunk.
 */
describe('runtimeCheckout', () => {
  it('reports the repository root git names', () => {
    expect(runtimeCheckout(() => 'D:/work/repo\n')).toBe('D:/work/repo');
  });

  it('falls back to its own directory rather than saying nothing when git cannot answer', () => {
    const thrown = runtimeCheckout(() => { throw new Error('not a git repository'); });
    expect(thrown).not.toBe('');
    expect(thrown.length).toBeGreaterThan(0);
  });

  it('falls back when git answers with nothing', () => {
    expect(runtimeCheckout(() => '  \n').length).toBeGreaterThan(0);
  });
});
