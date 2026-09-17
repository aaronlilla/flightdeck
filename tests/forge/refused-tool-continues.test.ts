/**
 * A tool call the worker rules refuse must not end the worker's session.
 *
 * The escape, 2026-09-14: the BBZ-303 queue run (`queue-BBZ-303-Q-842f5b17`) called Monitor
 * at 22:14:35.454Z, `buildPreToolUseHook` refused it and journalled `permission.denied`, and
 * `run.finished stopped` followed 168 ms later. Every Monitor refusal in the fleet journal
 * shows the same shape. The refusal was right; the session ending on it was the defect:
 * `engine.ts` answered every deny with `continue: false`, which ends the turn.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { replay } from '../../src/forge/journal.js';
import { SdkEngine } from '../../src/forge/sdkengine.js';
import { Worker } from '../../src/forge/worker.js';
import { sdkLikeQuery } from './sdk-like-query.js';

let home: string;
let journalPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-refused-'));
  journalPath = join(home, 'fleet.jsonl');
  process.env['FORGE_HOME'] = home;
});

const FORGE_DONE = 'mcp__forge__forge_done';

describe('a refused tool call does not end the worker session (BBZ-303 escape)', () => {
  it('a worker whose Monitor call is refused carries on to forge_done in the same turn', async () => {
    const { fn, ran, refusals } = sdkLikeQuery([
      [{ name: 'Monitor', input: { command: 'gh pr checks 12 --watch', persistent: true } },
        { name: FORGE_DONE, input: { evidence: 'draft PR opened' } }],
    ]);
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox'), gotchasDir: join(home, 'gotchas'), queryFn: fn,
    });
    const worker = new Worker({
      run: 'queue-BBZ-303-specimen', brief: '# Goal\n\nOpen the PR.\n', briefPath: join(home, 'brief.md'),
      cwd: home, journalPath, engine: engine as never, maxContext: 150_000,
    });

    const result = await worker.run();

    expect(refusals[0]).toMatch(/^Monitor: Monitor is refused inside a worker run/);
    const events = replay(journalPath).events.filter((e) => e.run === 'queue-BBZ-303-specimen');
    expect(events.some((e) => e.event === 'permission.denied' && e['tool'] === 'Monitor')).toBe(true);
    expect(ran).toContain(FORGE_DONE);
    expect(result.verdict).not.toBe('stopped');
    expect(events.find((e) => e.event === 'run.finished')?.['verdict']).not.toBe('stopped');
  });
});
