/**
 * `retire.ts` (H1.7): which lanes the board's own retire actions may touch, and the
 * append-only log that remembers which ones already were. Nothing here ever deletes a
 * row -- `retiredAt: null` undoes a retire, it never erases the history of it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readRetired, retireEligible, retireFinished, retirePreview, retireRun, unretireRun } from '../../../src/forge/console/retire.js';
import type { Lane } from '../../../src/shared/console-model.js';

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'console-retire-')), 'retired.jsonl');
}

function lane(overrides: Partial<Lane> = {}): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: 'alpha', ticket: null, model: 'sonnet-5', modelId: null, className: null, repo: null,
    attempt: 1, state: 'done', reason: null, stepN: 0, stepTotal: 0, stepText: '',
    ctxTokens: 0, ctxCeiling: 0, ctxCompactAt: 0, tokens: 0, tokenCap: null, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: 0, verifiedAt: null, heart: false,
    since: 0, startedAt: 0, endedAt: null, question: null, pr: null, sandbox: null,
    blockedBy: null, runaway: false, needsAaron: null, did: null, now: '', you: null,
    ...overrides,
  };
}

describe('retireEligible', () => {
  it('done, merged and killed are eligible with no live process', () => {
    expect(retireEligible(lane({ state: 'done' }))).toBe(true);
    expect(retireEligible(lane({ state: 'merged' }))).toBe(true);
    expect(retireEligible(lane({ state: 'killed' }))).toBe(true);
  });

  it('a finished probe is eligible even on exhausted/unverified', () => {
    expect(retireEligible(lane({ state: 'exhausted', kind: 'probe' }))).toBe(true);
    expect(retireEligible(lane({ state: 'unverified', kind: 'probe' }))).toBe(true);
  });

  it('a finished manual or chain run is eligible on unverified with no process and no PR', () => {
    // Seen live 2026-09-08: a manual run that ended `unverified` with no PR had no exit
    // at all -- kill, reopen and verify all refused it, and Clean up skipped it.
    expect(retireEligible(lane({ state: 'unverified', kind: 'manual' }))).toBe(true);
    expect(retireEligible(lane({ state: 'unverified', kind: 'chain' }))).toBe(true);
  });

  it('an unverified run with an open unmerged PR, or a live process, stays on the board', () => {
    const withPr = lane({ state: 'unverified', pr: { no: 1, url: 'x', files: 0, add: 0, del: 0, draft: true, merged: false } });
    expect(retireEligible(withPr)).toBe(false);
    expect(retireEligible(lane({ state: 'unverified', heart: true }))).toBe(false);
  });

  it('a non-probe exhausted run is not eligible: Kill and Reopen still reach it', () => {
    expect(retireEligible(lane({ state: 'exhausted', kind: 'manual' }))).toBe(false);
  });

  it('running, parked and blocked are never eligible', () => {
    expect(retireEligible(lane({ state: 'running' }))).toBe(false);
    expect(retireEligible(lane({ state: 'parked' }))).toBe(false);
    expect(retireEligible(lane({ state: 'blocked' }))).toBe(false);
  });

  it('a done lane with an open unmerged PR is not eligible', () => {
    const withPr = lane({ state: 'done', pr: { no: 1, url: 'x', files: 0, add: 0, del: 0, draft: true, merged: false } });
    expect(retireEligible(withPr)).toBe(false);
  });

  it('a done lane whose PR has already merged is eligible', () => {
    const withPr = lane({ state: 'done', pr: { no: 1, url: 'x', files: 0, add: 0, del: 0, draft: false, merged: true } });
    expect(retireEligible(withPr)).toBe(true);
  });

  it('a lane with a live process is never eligible, whatever its state says', () => {
    expect(retireEligible(lane({ state: 'done', heart: true }))).toBe(false);
  });
});

describe('retireRun / unretireRun / readRetired', () => {
  it('retiring writes a row, and reading it back reports retiredAt', () => {
    const path = tempPath();
    retireRun(path, 'alpha', 1_000);
    expect(readRetired(path).get('alpha')).toBe(1_000);
  });

  it('unretiring clears it, without erasing the earlier row', () => {
    const path = tempPath();
    retireRun(path, 'alpha', 1_000);
    unretireRun(path, 'alpha', 2_000);
    expect(readRetired(path).get('alpha')).toBeUndefined();
  });
});

describe('retireFinished', () => {
  it('retires every eligible lane not already retired, and reports which ones', () => {
    const path = tempPath();
    const lanes = [
      lane({ id: 'a', state: 'done' }),
      lane({ id: 'b', state: 'running' }),
      lane({ id: 'c', state: 'merged' }),
    ];
    const retiredIds = retireFinished(path, lanes, 5_000);
    expect(retiredIds.sort()).toEqual(['a', 'c']);
    expect(readRetired(path).get('a')).toBe(5_000);
    expect(readRetired(path).get('c')).toBe(5_000);
    expect(readRetired(path).has('b')).toBe(false);
  });

  it('never retires a lane twice', () => {
    const path = tempPath();
    retireRun(path, 'a', 1_000);
    const retiredIds = retireFinished(path, [lane({ id: 'a', state: 'done' })], 5_000);
    expect(retiredIds).toEqual([]);
  });
});

describe('retirePreview', () => {
  it('lists what a bulk retire would touch, without retiring anything', () => {
    const path = tempPath();
    const lanes = [
      lane({ id: 'a', title: 'Alpha', state: 'done' }),
      lane({ id: 'b', title: 'Bravo', state: 'running' }),
      lane({ id: 'c', title: null, state: 'merged' }),
    ];
    const items = retirePreview(path, lanes);
    expect(items).toEqual([{ id: 'a', title: 'Alpha' }, { id: 'c', title: null }]);
    expect(readRetired(path).size).toBe(0);
  });

  it('excludes a lane already retired', () => {
    const path = tempPath();
    retireRun(path, 'a', 1_000);
    const items = retirePreview(path, [lane({ id: 'a', state: 'done' })]);
    expect(items).toEqual([]);
  });
});
