import { describe, expect, it } from 'vitest';

import { analyze, type RunTranscript, type SelfAnalyzeInputs } from '../../../src/forge/self/analyze.js';
import type { Gotcha } from '../../../src/forge/gotcha.js';
import type { ForgeEvent, RunState } from '../../../src/forge/journal.js';

function gotcha(overrides: Partial<Gotcha>): Gotcha {
  return {
    id: 'g1', run: 'run-1', what: 'thing broke', where: 'src/forge/foo.ts', error: 'boom',
    prevention: 'do not do that', at: 1, hits: 1, runs: ['run-1'], lane: 'aaron',
    why: 'unplaced', disposition: 'carry-on', ...overrides,
  };
}

function baseInputs(overrides: Partial<SelfAnalyzeInputs> = {}): SelfAnalyzeInputs {
  return {
    gotchas: [], events: [], runs: [], attestationRounds: [], runTranscripts: [], now: 1_000_000,
    ...overrides,
  };
}

describe('analyze: gotcha-fix-lane', () => {
  it('finds nothing when no gotcha is in the fix lane (specimen: clean input)', () => {
    const findings = analyze(baseInputs({ gotchas: [gotcha({ lane: 'aaron' })] }));
    expect(findings.filter((f) => f.kind === 'gotcha-fix-lane')).toHaveLength(0);
  });

  it('surfaces a gotcha classified into the fix lane', () => {
    const g = gotcha({ id: 'g-fix', lane: 'fix', where: 'src/forge/gotcha.ts' });
    const findings = analyze(baseInputs({ gotchas: [g] }));
    const found = findings.filter((f) => f.kind === 'gotcha-fix-lane');
    expect(found).toHaveLength(1);
    expect(found[0]!.signature).toContain('g-fix');
  });
});

describe('analyze: tick-error-repeat', () => {
  const now = 1_000_000_000;
  function tickError(message: string, at: number): ForgeEvent {
    return {
      id: `e-${at}`, seq: at, at, version: 1, event: 'queue.tick-error', actor: 'queue', message,
    } as ForgeEvent;
  }

  it('does not fire on two identical errors (specimen: below threshold)', () => {
    const events = [tickError('boom', now - 1000), tickError('boom', now - 500)];
    const findings = analyze(baseInputs({ events, now }));
    expect(findings.filter((f) => f.kind === 'tick-error-repeat')).toHaveLength(0);
  });

  it('fires on three identical errors within 24h', () => {
    const events = [
      tickError('boom', now - 3000), tickError('boom', now - 2000), tickError('boom', now - 1000),
    ];
    const findings = analyze(baseInputs({ events, now }));
    const found = findings.filter((f) => f.kind === 'tick-error-repeat');
    expect(found).toHaveLength(1);
  });

  it('does not fire when the third repeat is outside the 24h window', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const events = [
      tickError('boom', now - dayMs - 1000), tickError('boom', now - 500), tickError('boom', now - 200),
    ];
    const findings = analyze(baseInputs({ events, now }));
    expect(findings.filter((f) => f.kind === 'tick-error-repeat')).toHaveLength(0);
  });
});

describe('analyze: coverage-miss-repeat', () => {
  it('does not fire on a single missing round', () => {
    const findings = analyze(baseInputs({
      attestationRounds: [{ repo: 'o/r', pr: 1, round: 1, missing: ['scope-conformance'] }],
    }));
    expect(findings.filter((f) => f.kind === 'coverage-miss-repeat')).toHaveLength(0);
  });

  it('fires when the same member is missing across two rounds', () => {
    const findings = analyze(baseInputs({
      attestationRounds: [
        { repo: 'o/r', pr: 1, round: 1, missing: ['scope-conformance'] },
        { repo: 'o/r', pr: 2, round: 1, missing: ['scope-conformance', 'regression-risk'] },
      ],
    }));
    const found = findings.filter((f) => f.kind === 'coverage-miss-repeat');
    expect(found.map((f) => f.signature)).toContain('scope-conformance');
    expect(found).toHaveLength(1);
  });
});

describe('analyze: token-outlier', () => {
  function run(name: string, className: string, tokensUsed: number): [string, RunState] {
    return [name, {
      run: name, state: 'finished', turns: 1, context: 0, costUsd: 0, tokensUsed, lastEventAt: 0,
      cacheReadTokens: 0, totalReadTokens: 0, turnsSinceWrite: 0, className,
    }];
  }

  it('does not fire when nothing is more than 3x the median', () => {
    const runs = Object.fromEntries([run('a', 'goal', 100), run('b', 'goal', 110), run('c', 'goal', 120)]);
    const findings = analyze(baseInputs({ runs: Object.values(runs) }));
    expect(findings.filter((f) => f.kind === 'token-outlier')).toHaveLength(0);
  });

  it('fires on a run over 3x the median for its class', () => {
    const runs = [run('a', 'goal', 100)[1], run('b', 'goal', 110)[1], run('c', 'goal', 100_000)[1]];
    const findings = analyze(baseInputs({ runs }));
    const found = findings.filter((f) => f.kind === 'token-outlier');
    expect(found).toHaveLength(1);
    expect(found[0]!.signature).toContain('c');
  });
});

describe('analyze: health-repeat', () => {
  function health(signal: string, at: number): ForgeEvent {
    return {
      id: `h-${at}`, seq: at, at, version: 1, event: 'warden.health', actor: 'warden', signal, key: 'run-1',
    } as ForgeEvent;
  }

  it('does not fire on two occurrences', () => {
    const events = [health('drift', 1), health('drift', 2)];
    expect(analyze(baseInputs({ events })).filter((f) => f.kind === 'health-repeat')).toHaveLength(0);
  });

  it('fires on three occurrences of the same reason', () => {
    const events = [health('drift', 1), health('drift', 2), health('drift', 3)];
    const found = analyze(baseInputs({ events })).filter((f) => f.kind === 'health-repeat');
    expect(found).toHaveLength(1);
    expect(found[0]!.signature).toContain('drift');
  });
});

describe('analyze: repeated-work', () => {
  function transcript(run: string, ticket: string, tools: string[]): RunTranscript {
    return { run, ticket, toolSequence: tools, gotchaIds: [], parkReasons: [] };
  }

  it('does not fire when the same shape appears in only one run', () => {
    const runs = [transcript('r1', 'T-1', ['Bash', 'Edit', 'Bash'])];
    expect(analyze(baseInputs({ runTranscripts: runs })).filter((f) => f.kind === 'repeated-work')).toHaveLength(0);
  });

  it('fires when the same tool shape recurs across two different tickets', () => {
    const runs = [
      transcript('r1', 'T-1', ['Bash', 'Edit', 'Bash']),
      transcript('r2', 'T-2', ['Bash', 'Edit', 'Bash']),
    ];
    const found = analyze(baseInputs({ runTranscripts: runs })).filter((f) => f.kind === 'repeated-work');
    expect(found).toHaveLength(1);
  });

  it('does not fire when the shape repeats but only within the same ticket', () => {
    const runs = [
      transcript('r1', 'T-1', ['Bash', 'Edit', 'Bash']),
      transcript('r2', 'T-1', ['Bash', 'Edit', 'Bash']),
    ];
    expect(analyze(baseInputs({ runTranscripts: runs })).filter((f) => f.kind === 'repeated-work')).toHaveLength(0);
  });
});

describe('analyze: stable ids', () => {
  it('gives the same finding the same id across two calls', () => {
    const g = gotcha({ id: 'g-fix', lane: 'fix' });
    const a = analyze(baseInputs({ gotchas: [g] }));
    const b = analyze(baseInputs({ gotchas: [g] }));
    expect(a[0]!.id).toBe(b[0]!.id);
  });
});
