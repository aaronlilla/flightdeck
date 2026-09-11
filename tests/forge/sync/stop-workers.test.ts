/**
 * R-68 item 5: whether `Fleet.stopAll` reaches a run in-process, proven before the
 * runner's `stop-workers` stage wires anything to it. Uses the test's OWN pid so
 * `processAlive` reads it as live without touching any other process, and `FORGE_HOME`
 * points at a temp dir so `RunInbox` (which `stopAll` writes through when it holds no
 * `LiveSession` for a goal) never touches the real `~/.forge`.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Fleet, Lanes } from '../../../src/forge/supervisor.js';
import { Registry } from '../../../src/forge/registry.js';

describe('Fleet.stopAll: in-process reach (R-68 item 5)', () => {
  let dir: string;
  let originalForgeHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sync-stopall-'));
    originalForgeHome = process.env['FORGE_HOME'];
    process.env['FORGE_HOME'] = dir;
  });

  afterEach(() => {
    if (originalForgeHome === undefined) delete process.env['FORGE_HOME'];
    else process.env['FORGE_HOME'] = originalForgeHome;
  });

  it('reports a run whose pid is this test\'s own pid as reached, via an inbox write', async () => {
    const registry = new Registry(join(dir, 'registry'));
    const lanes = new Lanes(join(dir, 'lanes'));
    const killSwitchFile = join(dir, 'kill-switch.json');
    const admitted = registry.admit({
      goal: 'sync-stopall-goal', cwd: dir, briefPath: join(dir, 'brief.md'), pid: process.pid,
    });
    expect(admitted.ok).toBe(true);

    const fleet = new Fleet(lanes, registry, join(dir, 'fleet.jsonl'), killSwitchFile);
    const result = await fleet.stopAll('sync full: stopping running workers');

    expect(result.stale).toEqual([]);
    expect(result.stopped).toHaveLength(1);
    expect(result.stopped[0]?.reached).toBe(true);
    expect(existsSync(killSwitchFile)).toBe(true);

    // "reached" here means an inbox write, per supervisor.ts's own contract for a goal
    // this process holds no LiveSession for -- confirm the write actually landed.
    const inboxDir = join(dir, 'runs', 'sync-stopall-goal', 'inbox');
    expect(existsSync(inboxDir)).toBe(true);
    const messages = readdirSync(inboxDir).filter((name) => name.endsWith('.json'));
    expect(messages).toHaveLength(1);
    const message = JSON.parse(readFileSync(join(inboxDir, messages[0]!), 'utf8')) as { text: string };
    expect(message.text.length).toBeGreaterThan(0);
  });

  it('a dead pid is reported stale, not stopped', async () => {
    const registry = new Registry(join(dir, 'registry'));
    const lanes = new Lanes(join(dir, 'lanes'));
    // A pid that is astronomically unlikely to be alive right now.
    const deadPid = 999_999;
    registry.admit({ goal: 'stale-goal', cwd: dir, briefPath: join(dir, 'brief.md'), pid: deadPid });

    const fleet = new Fleet(lanes, registry, join(dir, 'fleet.jsonl'));
    const result = await fleet.stopAll('reason');

    expect(result.stopped).toEqual([]);
    expect(result.stale).toEqual(['stale-goal']);
  });
});
