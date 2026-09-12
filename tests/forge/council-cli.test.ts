/**
 * `forge council` and `forge gate`: the acceptance specimens from the goal brief. Every
 * PR here is a fixture through a fake `gh` and every model answer is a fake Reasoner
 * reply -- no `gh` call and no model call anywhere in this file.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { forge } from '../../src/forge/cli.ts';
import { attestationPath } from '../../src/forge/council/attest.ts';
import type { CouncilAttestation } from '../../src/forge/contracts.ts';
import type { GhReader, GhWriter, PrSnapshot } from '../../src/forge/council/gh.ts';
import { modelIdFor } from '../../src/forge/policy.ts';
import { replay } from '../../src/forge/journal.ts';

// PR #123, 2026-09-08: the terminal printed `verdict: FIX FIRST` while the attestation
// written in the same breath said `PASS WITH NOTES`, and `forge gate` merged on that
// attestation -- an operator reading only the terminal would have believed the council
// had failed. `forge council`'s success path must print whatever it just wrote, never a
// value it computed before the write. This mock stands in for exactly that divergence:
// `writeAttestation` records what the round produced, but the file `readAttestation`
// hands back names a different verdict and finding set, the way a stale or concurrently
// overwritten attestation file would. A CLI that still prints from the in-memory `round`
// object passes this mock unnoticed; one that reads the write back does not.
const STALE_VERDICT: CouncilAttestation['verdict'] = 'PASS WITH NOTES';
const staleFinding = {
  member: 'council', file: '(stale)', line: 0, claim: 'this is the attested finding, not the round finding',
  failureScenario: 'proves the printed line came from the attestation on disk', severity: 'low' as const,
  confidence: 'high' as const,
};
// Off by default so every other test in this file reads the real file back untouched --
// only the one specimen below turns it on.
let simulateDivergentReadback = false;

vi.mock('../../src/forge/council/attest.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/forge/council/attest.ts')>();
  return {
    ...actual,
    readAttestation: (repo: string, pr: number, head: string) => {
      const onDisk = actual.readAttestation(repo, pr, head);
      if (!onDisk || !simulateDivergentReadback) return onDisk;
      // Hand back a verdict/finding set that differs from whatever `writeAttestation`
      // actually recorded, standing in for the file having diverged after the write.
      return { ...onDisk, verdict: STALE_VERDICT, decidingFindings: [staleFinding] };
    },
  };
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-council-cli-'));
  process.env['FORGE_HOME'] = home;
  delete process.env['FORGE_COUNCIL_REPOS'];
  delete process.env['FORGE_COUNCIL_AUTOMERGE'];
  delete process.env['FORGE_COUNCIL_CODEX'];
  for (const name of ['FORGE_JIRA_SITE', 'FORGE_JIRA_EMAIL', 'FORGE_JIRA_TOKEN', 'FORGE_JIRA_QA_ACCOUNT', 'FORGE_JIRA_QA_TRANSITION']) {
    delete process.env[name];
  }
  delete process.env['FORGE_REPO_KIND'];
  delete process.env['FORGE_SELF_REPO'];
  simulateDivergentReadback = false;
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
    async commentPr() { return { returncode: 0, stderr: '' }; },
    async viewPrState() { return { prState: 'OPEN' }; },
    async requestReviewer() { return { returncode: 0, stderr: '' }; },
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
    // GATE.md item 4: full coverage is on the attestation too, not only inferable from
    // an absent finding -- "reviewed by 1 of 1" should be as readable as "reviewed by 2 of 4".
    expect(attestation.coverage).toEqual({ total: 1, missing: [] });

    const state = replay(join(home, 'fleet.jsonl'));
    expect(state.events.some((e) => e.event === 'council.lens')).toBe(true);
    expect(state.events.some((e) => e.event === 'council.judge')).toBe(true);
    expect(state.events.some((e) => e.event === 'council.attested')).toBe(true);
  });

  // PR #123, 2026-09-08: the round itself resolved PASS WITH NOTES and wrote it to the
  // attestation, but the terminal printed FIX FIRST -- a different value than the one
  // `forge gate` went on to read and merge on. The printed line has to come from the
  // attestation that was just written, not from a value the CLI computed before the
  // write, or a diverged file (a stale one, or one another process overwrote) fools the
  // operator watching the terminal while the gate merges on the real one anyway.
  it('prints whatever the attestation on disk says, not whatever the round computed before the write', async () => {
    process.env['FORGE_COUNCIL_REPOS'] = REPO;
    const reasonerQueryFn = fakeQueryByModel({
      [LENS_MODEL]: JSON.stringify({ findings: [] }),
      [JUDGE_MODEL]: JSON.stringify({ verdict: 'PASS', decidingFindings: [] }),
    });

    simulateDivergentReadback = true;
    const result = await forge(['council', '--repo', REPO, '--pr', String(PR)], {
      councilGh: fakeGh([smallSnapshot(), smallSnapshot()]),
      reasonerQueryFn,
    });

    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toMatch(new RegExp(`verdict: ${STALE_VERDICT}`));
    expect(result.data?.['verdict']).toBe(STALE_VERDICT);
    expect(result.lines.join(' ')).toMatch(/this is the attested finding, not the round finding/);
    // The round's own verdict (PASS) never reaches the terminal once the readback
    // disagrees with it.
    expect(result.lines.join(' ')).not.toMatch(/verdict: PASS$/m);
  });

  it('accepts --cwd (and --base) alongside --repo/--pr without breaking a passing round', async () => {
    process.env['FORGE_COUNCIL_REPOS'] = REPO;
    const reasonerQueryFn = fakeQueryByModel({
      [LENS_MODEL]: JSON.stringify({ findings: [] }),
      [JUDGE_MODEL]: JSON.stringify({ verdict: 'PASS', decidingFindings: [] }),
    });

    const result = await forge(
      ['council', '--repo', REPO, '--pr', String(PR), '--cwd', '/checkout', '--base', 'develop'],
      { councilGh: fakeGh([smallSnapshot(), smallSnapshot()]), reasonerQueryFn },
    );

    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toMatch(/verdict: PASS/);
  });

  it('a judge FIX FIRST yields exit 1 and no attestation file', async () => {
    process.env['FORGE_COUNCIL_REPOS'] = REPO;
    // C.2: a round with no lens finding never calls the judge at all, so this needs a
    // real finding on the wire to exercise a judge FIX FIRST in the first place.
    const finding = {
      member: 'correctness', file: 'src/x.ts', line: 1, claim: 'off by one',
      failureScenario: 'boundary miscount', severity: 'high', confidence: 'high',
    };
    const reasonerQueryFn = fakeQueryByModel({
      [LENS_MODEL]: JSON.stringify({ findings: [finding] }),
      [JUDGE_MODEL]: JSON.stringify({ verdict: 'FIX FIRST', decidingFindings: [finding] }),
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

  it('a lens replying with prose never crashes the process: it is retried once, still records the failure honestly, and can never let the round clear (GATE.md item 1)', async () => {
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
    // A round missing its only lens can never clear, whatever the judge said -- coverage
    // is decided in code before the verdict is trusted, so this is FIX FIRST, not PASS.
    expect(result.code).toBe(1);
    expect(result.lines.join(' ')).toMatch(/verdict: FIX FIRST/);
    // GATE.md item 4: the gap is on the round's own result, not only recoverable by
    // reading the attestation file (which this verdict never even writes) -- a queue
    // item that parks on this can carry "reviewed by 0 of 1" as its own reason.
    expect(result.data?.['coverageNote']).toContain('reviewed by 0 of 1');
    expect(result.data?.['coverageNote']).toContain('correctness');

    // FIX FIRST writes no attestation: nothing here could ever have cleared the gate.
    const attPath = attestationPath(REPO, PR, 'head-1');
    expect(existsSync(attPath)).toBe(false);

    const state = replay(join(home, 'fleet.jsonl'));
    const lensRow = state.events.find((e) => e.event === 'council.lens');
    expect(lensRow?.['failed']).toBe(true);
    expect(lensRow?.['retried']).toBe(true);
    expect(String(lensRow?.['error'])).toMatch(/unparseable reply/);
  });

  it('the judge itself failing to answer at all (not a verdict, a hard failure) exits 1 with no attestation, and never crashes the process', async () => {
    process.env['FORGE_COUNCIL_REPOS'] = REPO;
    // C.2: a round with no lens finding never calls the judge at all, so this needs a
    // real finding on the wire to exercise a hard judge failure in the first place.
    const finding = {
      member: 'correctness', file: 'src/x.ts', line: 1, claim: 'off by one',
      failureScenario: 'boundary miscount', severity: 'high', confidence: 'high',
    };
    const reasonerQueryFn = fakeQueryByModel({
      [LENS_MODEL]: JSON.stringify({ findings: [finding] }),
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
    expect(result.data?.['pending']).toBeUndefined();
  });

  // BBZ-60/62/74/202, 2026-09-08: a `pending` conclusion is "not yet", never "no" -- the
  // gate must give a caller (`chainCouncil`, then the queue's `advanceItem`) a
  // machine-readable way to tell it apart from an actual failure, instead of forcing
  // everyone downstream to string-match the English refusal line.
  it('checks that are pending refuse the same way but mark data.pending, exit 2', async () => {
    process.env['FORGE_COUNCIL_REPOS'] = REPO;
    const result = await forge(['council', '--repo', REPO, '--pr', String(PR)], {
      councilGh: fakeGh([smallSnapshot({ checks: { runId: 'r', headSha: 'head-1', conclusion: 'pending' } })]),
    });
    expect(result.code).toBe(2);
    expect(result.lines.join(' ')).toMatch(/pending/);
    expect(result.data?.['pending']).toBe(true);
  });

  // Rival account 3, this plan: a bare hand-typed `forge council` never read
  // `FORGE_COUNCIL_CODEX`, so an operator setting it by hand got a round that looked
  // clean while the Codex lane never ran. Only the chain (`forceCodexLane` on `deps`)
  // honoured it before this. No `--cwd`/`--base` is passed, so the lane reports
  // `ran: false` without spawning anything, and a forced round can never clear on a
  // lane that stayed silent (`orchestrate.ts`'s own gap finding).
  it('honours FORGE_COUNCIL_CODEX=always on a bare CLI call with no forceCodexLane dep', async () => {
    process.env['FORGE_COUNCIL_REPOS'] = REPO;
    process.env['FORGE_COUNCIL_CODEX'] = 'always';
    const reasonerQueryFn = fakeQueryByModel({
      [LENS_MODEL]: JSON.stringify({ findings: [] }),
      [JUDGE_MODEL]: JSON.stringify({ verdict: 'PASS', decidingFindings: [] }),
    });

    const result = await forge(['council', '--repo', REPO, '--pr', String(PR)], {
      councilGh: fakeGh([smallSnapshot()]),
      reasonerQueryFn,
    });

    expect(result.code).toBe(1);
    expect(result.lines.join(' ')).toMatch(/FIX FIRST/);
    expect(result.lines.join(' ')).toMatch(/Codex lane did not run/);
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
    expect(result.data?.['pending']).toBeUndefined();
  });

  // Symmetry with `forge council`: a `pending` check on the gate hop is also "not yet",
  // never "no" -- marked on `data` rather than left for a caller to string-match.
  it('refuses when a check is pending on the current head, but marks data.pending', async () => {
    await attestPass();
    const result = await forge(['gate', '--repo', REPO, '--pr', String(PR)], {
      councilGh: fakeGh([
        smallSnapshot({ body: bodyWithHandoff(), checks: { runId: 'r', headSha: 'head-1', conclusion: 'pending' } }),
      ]),
    });
    expect(result.code).toBe(1);
    expect(result.lines.join(' ')).toMatch(/checks are pending/);
    expect(result.data?.['pending']).toBe(true);
  });

  it('refuses when the Haiping handoff is missing from the PR body on a frontend repo', async () => {
    await attestPass({ body: 'no handoff at all' });
    const result = await forge(['gate', '--repo', REPO, '--pr', String(PR)], {
      councilGh: fakeGh([smallSnapshot({ body: 'no handoff at all' })]),
    });
    expect(result.code).toBe(1);
    expect(result.lines.join(' ')).toMatch(/Haiping handoff/);
  });

  // Haiping only ever looks at a `frontend`-kind repo. Applying his handoff requirement
  // to a backend repo (or the self repo's own PRs) produced no QA plan a human would
  // use -- just a `REPLACE:`-riddled block a worker pasted to satisfy the schema
  // (PRs #79/#83), or a merge stuck on review because nobody had one to paste (PR #82).
  it('does not require a Haiping handoff for a repo whose kind is not frontend', async () => {
    process.env['FORGE_REPO_KIND'] = `${REPO}=backend`;
    await attestPass({ body: 'no handoff at all' });
    const result = await forge(['gate', '--repo', REPO, '--pr', String(PR)], {
      councilGh: fakeGh([smallSnapshot({ body: 'no handoff at all' })]),
    });
    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).not.toMatch(/Haiping handoff/);
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

describe('Forge Jira stream: J3, the handoff writes at forge gate --merge', () => {
  it('without FORGE_JIRA_* set, journals one jira.skipped row naming the missing variables and stays exit 0', async () => {
    await attestPass();
    process.env['FORGE_COUNCIL_AUTOMERGE'] = REPO;
    const result = await forge(['gate', '--repo', REPO, '--pr', String(PR), '--merge'], {
      councilGh: fakeGh([smallSnapshot({ body: bodyWithHandoff() })], {
        async viewPrState() { return { prState: 'MERGED' }; },
      }),
    });

    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toMatch(/jira skipped/);
    const state = replay(join(home, 'fleet.jsonl'));
    const skipped = state.events.find((e) => e.event === 'jira.skipped');
    expect(skipped).toBeTruthy();
    expect(String(skipped?.['reason'])).toContain('FORGE_JIRA_SITE');
  });

  it('with the environment present, runs the three handoff writes in order after the merge completes', async () => {
    await attestPass();
    process.env['FORGE_COUNCIL_AUTOMERGE'] = REPO;
    process.env['FORGE_JIRA_SITE'] = 'https://acme.atlassian.net';
    process.env['FORGE_JIRA_EMAIL'] = 'bot@acme.test';
    process.env['FORGE_JIRA_TOKEN'] = 'a-real-looking-secret-token-value-123456';
    process.env['FORGE_JIRA_QA_ACCOUNT'] = 'acc-1';
    process.env['FORGE_JIRA_QA_TRANSITION'] = '31';

    const calls: string[] = [];
    const result = await forge(['gate', '--repo', REPO, '--pr', String(PR), '--merge'], {
      councilGh: fakeGh([smallSnapshot({ body: bodyWithHandoff() })], {
        async viewPrState() { return { prState: 'MERGED' }; },
      }),
      jiraWrite: {
        async comment(key) { calls.push(`comment:${key}`); return { ok: true }; },
        async assign(key, accountId) { calls.push(`assign:${key}:${accountId}`); return { ok: true }; },
        async transition(key, transitionId) { calls.push(`transition:${key}:${transitionId}`); return { ok: true }; },
        async link(key, url) { calls.push(`link:${key}:${url}`); return { ok: true }; },
      },
    });

    expect(result.code).toBe(0);
    expect(calls).toEqual(['comment:BBZ-1', 'assign:BBZ-1:acc-1', 'transition:BBZ-1:31']);

    const state = replay(join(home, 'fleet.jsonl'));
    const rows = state.events.filter((e) => e.event.startsWith('external.'));
    expect(rows.filter((e) => e['kind'] === 'jira-comment').map((e) => e.event))
      .toEqual(['external.intent', 'external.call', 'external.complete']);
    expect(rows.filter((e) => e['kind'] === 'jira-assign').map((e) => e.event))
      .toEqual(['external.intent', 'external.call', 'external.complete']);
    expect(rows.filter((e) => e['kind'] === 'jira-transition').map((e) => e.event))
      .toEqual(['external.intent', 'external.call', 'external.complete']);
    const mergeRows = rows.filter((e) => e['kind'] === 'pr-merge').map((e) => e.event);
    expect(mergeRows).toEqual(['external.intent', 'external.call', 'external.complete']);
  });

  it('a failing comment call never fails the merge: the merge row stays complete and exit stays 0', async () => {
    await attestPass();
    process.env['FORGE_COUNCIL_AUTOMERGE'] = REPO;
    process.env['FORGE_JIRA_SITE'] = 'https://acme.atlassian.net';
    process.env['FORGE_JIRA_EMAIL'] = 'bot@acme.test';
    process.env['FORGE_JIRA_TOKEN'] = 'a-real-looking-secret-token-value-123456';

    const result = await forge(['gate', '--repo', REPO, '--pr', String(PR), '--merge'], {
      councilGh: fakeGh([smallSnapshot({ body: bodyWithHandoff() })], {
        async viewPrState() { return { prState: 'MERGED' }; },
      }),
      jiraWrite: {
        async comment() { return { ok: false, status: 500, body: 'server error' }; },
        async assign() { return { ok: true }; },
        async transition() { return { ok: true }; },
        async link() { return { ok: true }; },
      },
    });

    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toMatch(/merge complete/);
    expect(result.lines.join(' ')).toMatch(/jira-comment: unknown/);

    const state = replay(join(home, 'fleet.jsonl'));
    const mergeRows = state.events.filter((e) => e.event.startsWith('external.') && e['kind'] === 'pr-merge');
    expect(mergeRows.at(-1)?.event).toBe('external.complete');
    const commentRows = state.events.filter((e) => e.event.startsWith('external.') && e['kind'] === 'jira-comment');
    expect(commentRows.at(-1)?.event).toBe('external.unknown');
  });
});
