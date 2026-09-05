/**
 * `forge council` and `forge gate`: the acceptance specimens from the goal brief. Every
 * PR here is a fixture through a fake `gh` and every model answer is a fake Reasoner
 * reply -- no `gh` call and no model call anywhere in this file.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { forge } from '../../src/forge/cli.ts';
import { attestationPath } from '../../src/forge/council/attest.ts';
import type { GhReader, GhWriter, PrSnapshot } from '../../src/forge/council/gh.ts';
import { modelIdFor } from '../../src/forge/policy.ts';
import { replay } from '../../src/forge/journal.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-council-cli-'));
  process.env['FORGE_HOME'] = home;
  delete process.env['FORGE_COUNCIL_REPOS'];
  delete process.env['FORGE_COUNCIL_AUTOMERGE'];
});

const REPO = 'acme/widgets';
const PR = 105;
const LENS_MODEL = modelIdFor('sonnet');
const JUDGE_MODEL = modelIdFor('opus');

function smallSnapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    repo: REPO, pr: PR, headSha: 'head-1', baseSha: 'base-1', title: 'Fix the retry',
    body: 'Fixes the retry loop.',
    files: ['src/x.ts'], diffText: '+line one', changedLines: 5,
    checks: { runId: 'run-1', headSha: 'head-1', conclusion: 'success' },
    isDraft: false,
    ...overrides,
  };
}

function fakeGh(snapshots: PrSnapshot[], overrides: Partial<GhWriter> = {}): GhReader & GhWriter {
  let call = 0;
  return {
    async viewPr() {
      const snapshot = snapshots[Math.min(call, snapshots.length - 1)]!;
      call += 1;
      return snapshot;
    },
    async mergePr() { return { returncode: 0, stderr: '' }; /* overridden per test when exercised */ },
    async readyPr() { return { returncode: 0, stderr: '' }; },
    async viewPrState() { return { prState: 'OPEN' }; },
    ...overrides,
  };
}

/** A fake `query`: dispatches on the requested model so a lens reply and a judge reply
 *  can differ within the same council round, the way `ClaudeReasoner` actually reaches
 *  two different models for two different classes. */
function fakeQueryByModel(repliesByModel: Record<string, string>) {
  return ((params: { prompt: string | AsyncIterable<unknown>; options?: { model?: string; cwd?: string } }) => {
    const promptIter = params.prompt as AsyncIterable<unknown>;
    const model = params.options?.model ?? '';
    const text = repliesByModel[model] ?? '[]';
    async function* generate() {
      yield {
        type: 'system', subtype: 'init', session_id: 'council-cli-session',
        model, cwd: params.options?.cwd ?? '', tools: [], slash_commands: [],
      };
      for await (const _pushed of promptIter) {
        yield {
          type: 'assistant', session_id: 'council-cli-session',
          message: {
            model,
            content: [{ type: 'text', text }],
            usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 },
          },
        };
        yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1, total_cost_usd: 0 };
        return;
      }
    }
    return generate() as never;
  }) as never;
}

describe('forge council', () => {
  it('refuses a repo not on the allow-list, exit 2, no attestation written', async () => {
    const result = await forge(['council', '--repo', REPO, '--pr', String(PR)], {
      councilGh: fakeGh([smallSnapshot()]),
    });
    expect(result.code).toBe(2);
    expect(result.lines.join(' ')).toMatch(/allow-list/);
  });

  it('a passing fixture PR through a fake gh and fake Reasoner: attestation, journal rows, exit 0', async () => {
    process.env['FORGE_COUNCIL_REPOS'] = REPO;
    const reasonerQueryFn = fakeQueryByModel({
      [LENS_MODEL]: JSON.stringify({ findings: [] }),
      [JUDGE_MODEL]: JSON.stringify({ verdict: 'PASS', decidingFindings: [] }),
    });

    const result = await forge(['council', '--repo', REPO, '--pr', String(PR)], {
      councilGh: fakeGh([smallSnapshot(), smallSnapshot()]),
      reasonerQueryFn,
    });

    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toMatch(/verdict: PASS/);

    const attPath = attestationPath(REPO, PR, 'head-1');
    const attestation = JSON.parse(readFileSync(attPath, 'utf8'));
    expect(attestation.verdict).toBe('PASS');
    expect(attestation.head).toBe('head-1');

    const state = replay(join(home, 'fleet.jsonl'));
    expect(state.events.some((e) => e.event === 'council.lens')).toBe(true);
    expect(state.events.some((e) => e.event === 'council.judge')).toBe(true);
    expect(state.events.some((e) => e.event === 'council.attested')).toBe(true);
  });

  it('a judge FIX FIRST yields exit 1 and no attestation file', async () => {
    process.env['FORGE_COUNCIL_REPOS'] = REPO;
    const reasonerQueryFn = fakeQueryByModel({
      [LENS_MODEL]: JSON.stringify({ findings: [] }),
      [JUDGE_MODEL]: JSON.stringify({ verdict: 'FIX FIRST', decidingFindings: [] }),
    });

    const result = await forge(['council', '--repo', REPO, '--pr', String(PR)], {
      councilGh: fakeGh([smallSnapshot(), smallSnapshot()]),
      reasonerQueryFn,
    });

    expect(result.code).toBe(1);
    expect(() => readFileSync(attestationPath(REPO, PR, 'head-1'), 'utf8')).toThrow();
  });

  it('a moved head between the round and the write yields exit 2', async () => {
    process.env['FORGE_COUNCIL_REPOS'] = REPO;
    const reasonerQueryFn = fakeQueryByModel({
      [LENS_MODEL]: JSON.stringify({ findings: [] }),
      [JUDGE_MODEL]: JSON.stringify({ verdict: 'PASS', decidingFindings: [] }),
    });

    const result = await forge(['council', '--repo', REPO, '--pr', String(PR)], {
      councilGh: fakeGh([smallSnapshot(), smallSnapshot({ headSha: 'head-2' })]),
      reasonerQueryFn,
    });

    expect(result.code).toBe(2);
    expect(result.lines.join(' ')).toMatch(/head moved/);
  });

  // I19: a live lens answered with a fenced JSON array carrying a real finding, and
  // separately a lens answering with prose took the whole process down with an uncaught
  // exception (the parse failure propagated as a rejection nothing in `forge council`
  // ever caught). Both fixtures below drive the full `forge council` command, not just
  // the reasoner in isolation, since the crash happened in the wiring between them.
  it('a fenced JSON array reply from the lens (small diff, one lens) still yields the finding and exit 0', async () => {
    process.env['FORGE_COUNCIL_REPOS'] = REPO;
    const finding = {
      member: 'correctness', file: 'src/x.ts', line: 3, claim: 'off by one on the retry count',
      failureScenario: 'retries one time fewer than configured', severity: 'high', confidence: 'high',
    };
    const reasonerQueryFn = fakeQueryByModel({
      [LENS_MODEL]: '```json\n' + JSON.stringify([finding]) + '\n```',
      [JUDGE_MODEL]: JSON.stringify({ verdict: 'PASS WITH NOTES', decidingFindings: [finding] }),
    });

    const result = await forge(['council', '--repo', REPO, '--pr', String(PR)], {
      councilGh: fakeGh([smallSnapshot(), smallSnapshot()]),
      reasonerQueryFn,
    });

    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toMatch(/off by one on the retry count/);
  });

  it('a lens replying with prose never crashes the process: the round still produces a judge verdict and an attestation noting the failed lens', async () => {
    process.env['FORGE_COUNCIL_REPOS'] = REPO;
    const reasonerQueryFn = fakeQueryByModel({
      [LENS_MODEL]: 'sorry, I could not find anything actionable in this diff',
      [JUDGE_MODEL]: JSON.stringify({ verdict: 'PASS', decidingFindings: [] }),
    });

    let unhandled: unknown;
    const onUnhandled = (reason: unknown) => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandled);
    let result: Awaited<ReturnType<typeof forge>>;
    try {
      result = await forge(['council', '--repo', REPO, '--pr', String(PR)], {
        councilGh: fakeGh([smallSnapshot(), smallSnapshot()]),
        reasonerQueryFn,
      });
      // Give any straggling rejection a tick to surface before asserting on it.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toBeUndefined();
    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toMatch(/verdict: PASS/);

    const attPath = attestationPath(REPO, PR, 'head-1');
    const attestation = JSON.parse(readFileSync(attPath, 'utf8'));
    expect(attestation.lenses).toHaveLength(1);
    expect(attestation.lenses[0].failed).toBe(true);
    expect(attestation.lenses[0].findings[0].severity).toBe('medium');

    const state = replay(join(home, 'fleet.jsonl'));
    const lensRow = state.events.find((e) => e.event === 'council.lens');
    expect(lensRow?.['failed']).toBe(true);
    expect(String(lensRow?.['error'])).toMatch(/unparseable reply/);
  });

  it('the judge itself failing to answer at all (not a verdict, a hard failure) exits 1 with no attestation, and never crashes the process', async () => {
    process.env['FORGE_COUNCIL_REPOS'] = REPO;
    const reasonerQueryFn = fakeQueryByModel({
      [LENS_MODEL]: JSON.stringify({ findings: [] }),
      [JUDGE_MODEL]: 'sorry, I am not able to reach a verdict on this one',
    });

    let unhandled: unknown;
    const onUnhandled = (reason: unknown) => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandled);
    let result: Awaited<ReturnType<typeof forge>>;
    try {
      result = await forge(['council', '--repo', REPO, '--pr', String(PR)], {
        councilGh: fakeGh([smallSnapshot(), smallSnapshot()]),
        reasonerQueryFn,
      });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toBeUndefined();
    expect(result.code).toBe(1);
    expect(result.lines.join(' ')).toMatch(/judge could not produce a verdict/);
    expect(() => readFileSync(attestationPath(REPO, PR, 'head-1'), 'utf8')).toThrow();
  });

  it('checks that are not green refuse before any model call, exit 2', async () => {
    process.env['FORGE_COUNCIL_REPOS'] = REPO;
    const result = await forge(['council', '--repo', REPO, '--pr', String(PR)], {
      councilGh: fakeGh([smallSnapshot({ checks: { runId: 'r', headSha: 'head-1', conclusion: 'failure' } })]),
    });
    expect(result.code).toBe(2);
    expect(result.lines.join(' ')).toMatch(/not green/);
  });
});

const HAIPING_HANDOFF = {
  ticket: 'BBZ-1', pr: `${REPO}#${PR}`, deployKind: 'ota',
  perPlatform: { android: 'abc', ios: 'def' },
  steps: ['open the app'], notVisuallyVerified: [],
};

function bodyWithHandoff(): string {
  return `Fixes it.\n\n\`\`\`json\n${JSON.stringify(HAIPING_HANDOFF)}\n\`\`\`\n`;
}

async function attestPass(overrides: Partial<PrSnapshot> = {}): Promise<PrSnapshot> {
  process.env['FORGE_COUNCIL_REPOS'] = REPO;
  const snapshot = smallSnapshot({ body: bodyWithHandoff(), ...overrides });
  const reasonerQueryFn = fakeQueryByModel({
    [LENS_MODEL]: JSON.stringify({ findings: [] }),
    [JUDGE_MODEL]: JSON.stringify({ verdict: 'PASS', decidingFindings: [] }),
  });
  const result = await forge(['council', '--repo', REPO, '--pr', String(PR)], {
    councilGh: fakeGh([snapshot, snapshot]),
    reasonerQueryFn,
  });
  expect(result.code).toBe(0);
  return snapshot;
}

describe('forge gate', () => {
  it('refuses when there is no attestation for the current head', async () => {
    const result = await forge(['gate', '--repo', REPO, '--pr', String(PR)], {
      councilGh: fakeGh([smallSnapshot({ body: bodyWithHandoff() })]),
    });
    expect(result.code).toBe(1);
    expect(result.lines.join(' ')).toMatch(/no attestation/);
  });

  it('refuses when the head has moved since the attestation', async () => {
    await attestPass();
    const result = await forge(['gate', '--repo', REPO, '--pr', String(PR)], {
      councilGh: fakeGh([smallSnapshot({ body: bodyWithHandoff(), headSha: 'head-2' })]),
    });
    expect(result.code).toBe(1);
  });

  it('refuses when a check is red on the current head', async () => {
    await attestPass();
    const result = await forge(['gate', '--repo', REPO, '--pr', String(PR)], {
      councilGh: fakeGh([
        smallSnapshot({ body: bodyWithHandoff(), checks: { runId: 'r', headSha: 'head-1', conclusion: 'failure' } }),
      ]),
    });
    expect(result.code).toBe(1);
    expect(result.lines.join(' ')).toMatch(/checks are failure/);
  });

  it('refuses when the Haiping handoff is missing from the PR body', async () => {
    await attestPass({ body: 'no handoff at all' });
    const result = await forge(['gate', '--repo', REPO, '--pr', String(PR)], {
      councilGh: fakeGh([smallSnapshot({ body: 'no handoff at all' })]),
    });
    expect(result.code).toBe(1);
    expect(result.lines.join(' ')).toMatch(/Haiping handoff/);
  });

  it('passes without --merge and says so, without touching gh.mergePr', async () => {
    await attestPass();
    let mergeCalled = false;
    const result = await forge(['gate', '--repo', REPO, '--pr', String(PR)], {
      councilGh: fakeGh([smallSnapshot({ body: bodyWithHandoff() })], {
        async mergePr() { mergeCalled = true; return { returncode: 0, stderr: '' }; },
      }),
    });
    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toMatch(/PASS/);
    expect(mergeCalled).toBe(false);
  });

  it('--merge on a repo outside autoMerge prints the Joe handoff and exits 3', async () => {
    await attestPass();
    const result = await forge(['gate', '--repo', REPO, '--pr', String(PR), '--merge'], {
      councilGh: fakeGh([smallSnapshot({ body: bodyWithHandoff() })]),
    });
    expect(result.code).toBe(3);
    expect(result.lines.join(' ')).toMatch(/autoMerge/);
    expect(result.lines.join(' ')).toMatch(/draftPr/);
  });

  it('--merge on an autoMerge-allowed repo calls gh pr merge exactly once and journals intent/call/complete', async () => {
    await attestPass();
    process.env['FORGE_COUNCIL_AUTOMERGE'] = REPO;
    let mergeCalls: { subject: string; body: string }[] = [];
    const result = await forge(['gate', '--repo', REPO, '--pr', String(PR), '--merge'], {
      councilGh: fakeGh([smallSnapshot({ body: bodyWithHandoff() })], {
        async mergePr(_repo, _pr, subject, body) { mergeCalls.push({ subject, body }); return { returncode: 0, stderr: '' }; },
        async viewPrState() { return { prState: 'MERGED' }; },
      }),
    });

    expect(result.code).toBe(0);
    expect(mergeCalls.length).toBe(1);
    expect(mergeCalls[0]?.subject).toBeTruthy();
    expect(mergeCalls[0]?.body).toBeTruthy();

    const state = replay(join(home, 'fleet.jsonl'));
    const kinds = state.events.filter((e) => e.event.startsWith('external.')).map((e) => e.event);
    expect(kinds).toContain('external.intent');
    expect(kinds).toContain('external.call');
    expect(kinds).toContain('external.complete');
  });

  /**
   * F5: `forge gate --repo <repo> --pr 105 --merge` on 2026-09-05 at 01:17 printed only
   * `merge unknown: <repo>#105` and exited 1, journaling `external.intent`,
   * `external.call` and `external.unknown` for kind `pr-merge` with no reason. The PR
   * was a draft, which `gh pr merge` refuses -- the gate never looked at `isDraft`.
   */
  it('F5: a merge decision on a draft PR marks it ready before ever calling mergePr', async () => {
    await attestPass();
    process.env['FORGE_COUNCIL_AUTOMERGE'] = REPO;
    const calls: string[] = [];
    const result = await forge(['gate', '--repo', REPO, '--pr', String(PR), '--merge'], {
      councilGh: fakeGh([smallSnapshot({ body: bodyWithHandoff(), isDraft: true })], {
        async readyPr() { calls.push('ready'); return { returncode: 0, stderr: '' }; },
        async mergePr() { calls.push('merge'); return { returncode: 0, stderr: '' }; },
        async viewPrState() { return { prState: 'MERGED' }; },
      }),
    });

    expect(result.code).toBe(0);
    expect(calls).toEqual(['ready', 'merge']);

    const state = replay(join(home, 'fleet.jsonl'));
    const rows = state.events.filter((e) => e.event.startsWith('external.'));
    const readyRows = rows.filter((e) => e['kind'] === 'pr-ready').map((e) => e.event);
    const mergeRows = rows.filter((e) => e['kind'] === 'pr-merge').map((e) => e.event);
    expect(readyRows).toEqual(['external.intent', 'external.call', 'external.complete']);
    expect(mergeRows).toEqual(['external.intent', 'external.call', 'external.complete']);
    // The ready cycle has to finish before the merge cycle starts, not merely appear
    // somewhere in the same journal.
    expect(rows.indexOf(rows.find((e) => e['kind'] === 'pr-ready' && e.event === 'external.complete')!))
      .toBeLessThan(rows.indexOf(rows.find((e) => e['kind'] === 'pr-merge' && e.event === 'external.intent')!));
  });

  it('F5: a merge call whose stderr names the draft refusal produces an external.unknown row carrying it', async () => {
    await attestPass();
    process.env['FORGE_COUNCIL_AUTOMERGE'] = REPO;
    const draftStderr = 'GraphQL: Pull request is in draft state (mergePullRequest)';
    const result = await forge(['gate', '--repo', REPO, '--pr', String(PR), '--merge'], {
      councilGh: fakeGh([smallSnapshot({ body: bodyWithHandoff() })], {
        async mergePr() { return { returncode: 1, stderr: draftStderr }; },
        async viewPrState() { return { prState: 'OPEN' }; },
      }),
    });

    expect(result.code).toBe(1);
    expect(result.lines.join(' ')).toContain('draft state');
    expect(result.lines.join(' ')).toMatch(/exit 1/);

    const state = replay(join(home, 'fleet.jsonl'));
    const unknownRow = state.events.find((e) => e.event === 'external.unknown' && e['kind'] === 'pr-merge');
    expect(unknownRow).toBeTruthy();
    expect(unknownRow?.['exitCode']).toBe(1);
    expect(String(unknownRow?.['stderr'])).toContain('draft state');
  });
});

describe('forge gate: base moved also refuses', () => {
  it('refuses when the attested base no longer matches the PR\'s current base', async () => {
    await attestPass();
    const result = await forge(['gate', '--repo', REPO, '--pr', String(PR)], {
      councilGh: fakeGh([smallSnapshot({ body: bodyWithHandoff(), baseSha: 'base-2' })]),
    });
    expect(result.code).toBe(1);
  });
});
