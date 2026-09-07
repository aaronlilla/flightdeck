import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { developDeployVerifier, parseWorkflowRuns, parseWorkflowView, otaOutcome } from '../../../src/forge/intake/otaVerify.js';

const here = join(__dirname, 'fixtures');
const runsText = readFileSync(join(here, 'eas-workflow-runs.txt'), 'utf8');
const viewText = readFileSync(join(here, 'eas-workflow-view.txt'), 'utf8');

describe('parseWorkflowRuns', () => {
  it('reads every run block with its workflow, status and start time', () => {
    const runs = parseWorkflowRuns(runsText);
    expect(runs.map((r) => [r.workflow, r.status])).toEqual([
      ['pr-checks.yml', 'SUCCESS'], ['deploy-develop.yml', 'IN_PROGRESS'], ['deploy-develop.yml', 'FAILURE'],
    ]);
    expect(runs[1]!.runId).toBe('01a073fa-9316-7c19-87e0-c194e53dae9c');
    expect(runs[1]!.startedAt).toBe(Date.parse('2026-09-05T23:49:56.630Z'));
  });
});

describe('parseWorkflowView', () => {
  it('reads the trigger sha, the run status and each job key, status and outputs', () => {
    const view = parseWorkflowView(viewText);
    expect(view.status).toBe('SUCCESS');
    expect(view.triggerSha).toBe('f9b9bde3cbcb');
    expect(view.jobs.map((j) => j.key)).toEqual(['quality', 'decide', 'update_ios', 'build_android']);
    expect(view.jobs[1]!.outputs['android_action']).toBe('build');
    expect(view.jobs[1]!.outputs['ios_hash']).toBe('12cd45b8fb92dadddb83d98dbc53ef1d0427f51d');
  });
});

describe('otaOutcome', () => {
  it('reports each platform as its decide action plus the short fingerprint', () => {
    expect(otaOutcome(parseWorkflowView(viewText))).toEqual({
      ios: 'update 12cd45b8', android: 'build 10cbd28a',
    });
  });
  it('is undefined while the decide job has not produced outputs', () => {
    const early = viewText.replace(/  Outputs:[\s\S]*?commit_subject[^\n]*\n/, '');
    expect(otaOutcome(parseWorkflowView(early))).toBeUndefined();
  });
});

describe('developDeployVerifier', () => {
  const mergedAt = Date.parse('2026-09-05T23:49:00.000Z');

  it('finds the deploy run started after the merge and polls it to a terminal status', async () => {
    const calls: string[][] = [];
    let views = 0;
    const running = viewText.replace('Status              SUCCESS', 'Status              IN_PROGRESS');
    const verify = developDeployVerifier({
      checkout: '/tmp/checkout', workflow: 'deploy-develop.yml',
      exec: async (argv) => { calls.push(argv); if (argv.includes('workflow:runs')) return runsText; views += 1; return views === 1 ? running : viewText; },
      clock: () => mergedAt + 60_000, sleep: async () => {}, pollMs: 1, maxWaitMs: 60_000,
    });
    const outcome = await verify({ repo: 'owner/name', branch: 'feature/x', mergedAt });
    expect(outcome).toEqual({ ios: 'update 12cd45b8', android: 'build 10cbd28a' });
    expect(calls[0]!.slice(0, 3)).toEqual(['npx', 'eas-cli', 'workflow:runs']);
    expect(calls.filter((c) => c.includes('workflow:view'))).toHaveLength(2);
  });

  it('gives up with undefined when no run for that workflow starts after the merge inside the wait', async () => {
    let now = mergedAt;
    const verify = developDeployVerifier({
      checkout: '/tmp/checkout', workflow: 'deploy-develop.yml',
      exec: async () => runsText.replace(/deploy-develop\.yml/g, 'other.yml'),
      clock: () => now, sleep: async () => { now += 30_000; }, pollMs: 1, maxWaitMs: 90_000,
    });
    expect(await verify({ repo: 'owner/name', branch: 'feature/x', mergedAt })).toBeUndefined();
  });

  it('ignores a deploy run that started before the merge', async () => {
    let now = mergedAt;
    const verify = developDeployVerifier({
      checkout: '/tmp/checkout', workflow: 'deploy-develop.yml',
      exec: async () => runsText,
      clock: () => now, sleep: async () => { now += 30_000; }, pollMs: 1, maxWaitMs: 60_000,
    });
    // both deploy runs in the listing started on the 5th; a merge on the 7th finds none.
    expect(await verify({ repo: 'owner/name', branch: 'feature/x', mergedAt: Date.parse('2026-09-07T00:00:00Z') })).toBeUndefined();
  });
});
