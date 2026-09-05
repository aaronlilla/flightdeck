/**
 * The real `CodexLane` (`codexLane.ts`). Every specimen injects a fake `CodexCallRunner`,
 * so nothing here spawns a process or reaches the network -- the guardrail `roles.ts`
 * already states for the Sonnet lenses applies to this lane too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCodexLane } from '../../../src/forge/council/codexLane.ts';
import type { CodexCallRequest, CodexCallResult, CodexCallRunner } from '../../../src/forge/council/codexLane.ts';
import { Journal } from '../../../src/forge/journal.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One genericised envelope, shaped like a real `codex_call.py review` reply
 *  (`dev-harness/tools/schemas/codex-findings.schema.json`), with every path and name
 *  replaced by a placeholder before being committed here. */
function fakeEnvelope(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ok: true,
    run_id: 'run-abc123',
    model: 'a-review-model',
    duration_s: 12.3,
    result: {
      verdict: 'needs-attention',
      summary: 'Two findings worth a look.',
      findings: [
        {
          file: 'app/widgets/Thing.ts',
          line_start: 10,
          line_end: 12,
          severity: 'high',
          title: 'Unchecked null',
          claim: 'This dereferences a value that can be null.',
          failure_scenario: 'A caller with an empty payload crashes the process.',
          confidence: 0.9,
          recommendation: 'Add a null check before use.',
        },
        {
          file: 'app\\widgets\\Other.ts',
          line_start: 40,
          line_end: 41,
          severity: 'low',
          title: 'Unused import',
          claim: 'This import is never referenced.',
          failure_scenario: 'None; a lint-only nit.',
          confidence: 0.3,
          recommendation: 'Remove the import.',
        },
      ],
      coverage_notes: 'Read every changed file. No build or test run performed.',
    },
    error: null,
    ...overrides,
  };
}

function runnerReturning(result: CodexCallResult): CodexCallRunner {
  return { run: vi.fn(async () => result) };
}

const BASE_ENV = { ...process.env };

beforeEach(() => {
  process.env['FORGE_CODEX_CALL'] = 'a-test-command --flag';
  delete process.env['FORGE_CODEX_TIMEOUT_S'];
});

afterEach(() => {
  process.env = { ...BASE_ENV };
});

describe('makeCodexLane', () => {
  it('missing cwd or baseRef never calls the runner and returns ran: false with a reason', async () => {
    const runner = runnerReturning({ exitCode: 0, stdout: '{}', timedOut: false });
    const lane = makeCodexLane({ runner });

    const noCwd = await lane.run({ brief: 'b', diffSummary: 'd', baseRef: 'main' });
    const noBase = await lane.run({ brief: 'b', diffSummary: 'd', cwd: 'C:/checkout' });

    expect(noCwd.ran).toBe(false);
    expect(noCwd.reason).toMatch(/cwd/);
    expect(noBase.ran).toBe(false);
    expect(noBase.reason).toMatch(/baseRef/);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('a stored envelope with two findings maps to two codex findings with normalised paths', async () => {
    const envelope = fakeEnvelope();
    const runner = runnerReturning({ exitCode: 0, stdout: JSON.stringify(envelope), timedOut: false });
    const lane = makeCodexLane({ runner, run: 'org/app#42' });

    const result = await lane.run({ brief: 'review this', diffSummary: 'd', cwd: 'C:/checkout', baseRef: 'develop' });

    expect(result.ran).toBe(true);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]!.member).toBe('codex');
    expect(result.findings[0]!.file).toBe('app/widgets/Thing.ts');
    expect(result.findings[0]!.line).toBe(10);
    expect(result.findings[0]!.severity).toBe('high');
    expect(result.findings[0]!.confidence).toBe('high');
    expect(result.findings[1]!.file).toBe('app/widgets/Other.ts');
    expect(result.findings[1]!.confidence).toBe('low');
  });

  it('passes --base, --cwd and a focus file through to the runner', async () => {
    const envelope = fakeEnvelope({ result: { findings: [] } });
    const runner: CodexCallRunner = {
      run: vi.fn(async (request: CodexCallRequest) => {
        expect(request.argv).toContain('review');
        expect(request.argv).toContain('--base');
        expect(request.argv).toContain('develop');
        expect(request.argv).toContain('--cwd');
        expect(request.argv).toContain('C:/checkout');
        expect(request.argv).toContain('--focus-file');
        const focusIndex = request.argv.indexOf('--focus-file');
        const focusPath = request.argv[focusIndex + 1]!;
        expect(readFileSync(focusPath, 'utf8')).toBe('the brief text');
        return { exitCode: 0, stdout: JSON.stringify(envelope), timedOut: false };
      }),
    };
    const lane = makeCodexLane({ runner, run: 'org/app#42' });

    await lane.run({ brief: 'the brief text', diffSummary: 'd', cwd: 'C:/checkout', baseRef: 'develop' });

    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it('ok: false yields the uncovered finding with the error text, ran stays true', async () => {
    const envelope = fakeEnvelope({ ok: false, error: 'codex could not answer', result: undefined });
    const runner = runnerReturning({ exitCode: 0, stdout: JSON.stringify(envelope), timedOut: false });
    const lane = makeCodexLane({ runner });

    const result = await lane.run({ brief: 'b', diffSummary: 'd', cwd: 'C:/checkout', baseRef: 'develop' });

    expect(result.ran).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.severity).toBe('critical');
    expect(result.findings[0]!.claim).toContain('codex could not answer');
  });

  it('a non-zero exit yields the uncovered finding naming the exit code', async () => {
    const runner = runnerReturning({ exitCode: 3, stdout: 'not json', timedOut: false });
    const lane = makeCodexLane({ runner });

    const result = await lane.run({ brief: 'b', diffSummary: 'd', cwd: 'C:/checkout', baseRef: 'develop' });

    expect(result.ran).toBe(true);
    expect(result.findings[0]!.claim).toContain('3');
  });

  it('a timeout yields the uncovered finding naming the timeout', async () => {
    const runner = runnerReturning({ exitCode: null, stdout: '', timedOut: true });
    const lane = makeCodexLane({ runner, timeoutS: 42 });

    const result = await lane.run({ brief: 'b', diffSummary: 'd', cwd: 'C:/checkout', baseRef: 'develop' });

    expect(result.ran).toBe(true);
    expect(result.findings[0]!.claim).toMatch(/timed out/);
    expect(result.findings[0]!.claim).toContain('42');
  });

  it('unparseable stdout yields the uncovered finding rather than throwing', async () => {
    const runner = runnerReturning({ exitCode: 0, stdout: 'this is not json at all', timedOut: false });
    const lane = makeCodexLane({ runner });

    const result = await lane.run({ brief: 'b', diffSummary: 'd', cwd: 'C:/checkout', baseRef: 'develop' });

    expect(result.ran).toBe(true);
    expect(result.findings[0]!.claim).toContain('Codex lane uncovered');
  });

  it('journals one council.lens row for the lane carrying run id, model and duration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-lane-journal-'));
    const journalPath = join(dir, 'journal.jsonl');
    const journal = new Journal(journalPath);
    try {
      const envelope = fakeEnvelope();
      const runner = runnerReturning({ exitCode: 0, stdout: JSON.stringify(envelope), timedOut: false });
      const lane = makeCodexLane({ runner, journal, run: 'org/app#7' });

      await lane.run({ brief: 'b', diffSummary: 'd', cwd: 'C:/checkout', baseRef: 'develop' });

      const lines = readFileSync(journalPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const row = lines.find((l) => l.event === 'council.lens' && l.lane === 'codex');
      expect(row).toBeDefined();
      expect(row.run_id).toBe('run-abc123');
      expect(row.model).toBe('a-review-model');
      expect(row.duration_s).toBe(12.3);
      expect(row.findings).toBe(2);
    } finally {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
