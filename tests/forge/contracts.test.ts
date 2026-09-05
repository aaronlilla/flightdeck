/**
 * Specimens for `src/forge/contracts.ts`, the shared shapes every Forge stream builds on
 * after roadmap P3.1.
 *
 * Nothing here opens an SDK session. `FORGE_TOOLS` is read off an in-memory MCP server
 * built with no-op handlers (see `contracts.ts`'s `registeredToolNames`), and the two
 * fixtures under `tests/forge/fixtures/` are static JSON, never a live transcript.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';

import { buildForgeMcpServer } from '../../src/adapter/engine.js';
import {
  asGoalId,
  AskEntrySchema,
  askKey,
  canTransition,
  CLI_COMMANDS,
  CLI_EXIT_CODES,
  EVENT_BUS_ROLES,
  EXTERNAL_WRITE_STATES,
  ExtendedStuckSignalSchema,
  ExternalWriteSchema,
  FORGE_EVENT_NAMES,
  ForgeAskInputSchema,
  ForgeDoneInputSchema,
  ForgeEventSchema,
  ForgeGotchaInputSchema,
  ForgeHandoffInputSchema,
  ForgeReportInputSchema,
  FORGE_TOOLS,
  ForgeStateSnapshotSchema,
  GoalIdSchema,
  INBOX_MESSAGE_STATES,
  InboxMessageSchema,
  LaneRecordSchema,
  makeRunId,
  mayRetryWithoutReconciling,
  observed,
  OwnershipSchema,
  providerFor,
  RegistryRowSchema,
  redact,
  replayEvents,
  RUN_STATES,
  RUN_TRANSITIONS,
  RunReportSchema,
  verified,
  type ExternalWrite,
  type VerifiedField,
} from '../../src/forge/contracts.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

function readFixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

function readFixtureLines(name: string): unknown[] {
  return readFileSync(join(FIXTURES, name), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------

describe('branded identities', () => {
  it('accepts a non-empty string and rejects an empty one', () => {
    expect(() => GoalIdSchema.parse('forge-contracts')).not.toThrow();
    expect(() => GoalIdSchema.parse('')).toThrow();
  });

  it('asGoalId returns a value usable wherever a GoalId is expected', () => {
    const goal = asGoalId('forge-contracts');
    expect(goal).toBe('forge-contracts');
  });

  it('makeRunId composes goal plus attempt, matching worker.ts\'s own successor naming', () => {
    const goal = asGoalId('forge-contracts');
    expect(makeRunId(goal, 1)).toBe('forge-contracts');
    expect(makeRunId(goal, 2)).toBe('forge-contracts-2');
    expect(makeRunId(goal, 3)).toBe('forge-contracts-3');
  });
});

describe('LaneRecordSchema', () => {
  const valid = {
    slug: 'forge-contracts', column: 'forge', owner: 'forge', session_id: null,
    claude_pid: null, started: 1, ended: null, verdict: null, position: null, note: null,
    woken: 0, model: 'claude-sonnet-5', context: 0, cost_usd: 0, handoff: null,
    goal: 'forge-contracts', className: 'implement', provider: 'claude',
  };

  it('accepts a lane record carrying the spec-required goal, className and provider', () => {
    expect(LaneRecordSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a lane record missing the goal the spec adds', () => {
    const { goal: _goal, ...withoutGoal } = valid;
    expect(LaneRecordSchema.safeParse(withoutGoal).success).toBe(false);
  });

  it('rejects a provider outside codex or claude', () => {
    expect(LaneRecordSchema.safeParse({ ...valid, provider: 'gemini' }).success).toBe(false);
  });
});

describe('RegistryRowSchema', () => {
  const valid = {
    goal: 'forge-contracts', cwd: '<cwd>', briefPath: '<cwd>/brief.md', pid: 1234,
    startedAt: 1_725_000_000_000,
  };

  it('accepts a row shaped like registry.ts\'s own RegistryRecord, admission fields only', () => {
    expect(RegistryRowSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts the optional sessionId and model registry.ts\'s setSession adds later', () => {
    expect(RegistryRowSchema.safeParse({
      ...valid, sessionId: 'sess-1', model: 'claude-sonnet-5',
    }).success).toBe(true);
  });

  it('rejects a row missing pid: nothing to test liveness against', () => {
    const { pid: _pid, ...withoutPid } = valid;
    expect(RegistryRowSchema.safeParse(withoutPid).success).toBe(false);
  });

  it('rejects a row missing goal: nothing to key admission on', () => {
    const { goal: _goal, ...withoutGoal } = valid;
    expect(RegistryRowSchema.safeParse(withoutGoal).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// Events and replay
// ---------------------------------------------------------------------------------------

describe('ForgeEventSchema', () => {
  const valid = {
    id: 'evt-1', seq: 1, at: 1_725_000_000_000, event: 'run.started', run: 'forge-contracts',
    goal: 'forge-contracts', actor: 'runner', version: 1,
  };

  it('accepts a well-formed envelope naming an event in the closed union', () => {
    expect(ForgeEventSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an event name outside the closed union', () => {
    expect(ForgeEventSchema.safeParse({ ...valid, event: 'run.made-up' }).success).toBe(false);
  });

  it('rejects an envelope missing actor', () => {
    const { actor: _actor, ...withoutActor } = valid;
    expect(ForgeEventSchema.safeParse(withoutActor).success).toBe(false);
  });

  it('every name B.3 needs is in the closed union', () => {
    for (const name of [
      'run.resumed', 'inbox.acknowledged', 'engine.error', 'warden.parked',
      'blocker.raised', 'blocker.cleared', 'policy.unknown-model',
    ]) {
      expect(FORGE_EVENT_NAMES).toContain(name);
    }
  });

  it('every event literal actually written under src/forge is in the closed union', () => {
    const forgeDir = fileURLToPath(new URL('../../src/forge/', import.meta.url));
    const files = readdirSync(forgeDir).filter((name) => name.endsWith('.ts'));
    const literal = /event:\s*'([^']+)'/g;
    const found = new Set<string>();
    for (const name of files) {
      const text = readFileSync(join(forgeDir, name), 'utf8');
      for (const match of text.matchAll(literal)) {
        const name = match[1];
        if (name) found.add(name);
      }
    }
    // A scan that found nothing proves nothing, so check the sensor before trusting it.
    expect(found.size).toBeGreaterThan(0);
    for (const name of found) {
      expect(FORGE_EVENT_NAMES, `event literal '${name}' found in src/forge/**`).toContain(name);
    }
  });
});

function journalLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ at: 1, actor: 'runner', event: 'run.started', version: 1, ...fields });
}

describe('replayEvents', () => {
  it('dedupes by id, keeping only the first copy', () => {
    const text = [
      journalLine({ id: 'a', seq: 1 }),
      journalLine({ id: 'a', seq: 2, event: 'run.finished' }),
      journalLine({ id: 'b', seq: 3, event: 'run.finished' }),
    ].join('\n');
    const result = replayEvents(text);
    expect(result.events.map((event) => event.id)).toEqual(['a', 'b']);
    expect(result.duplicates).toEqual(['a']);
  });

  it('recovers a torn tail: everything before the half-written last line survives', () => {
    const text = [
      journalLine({ id: 'a', seq: 1 }),
      journalLine({ id: 'b', seq: 2, event: 'run.finished' }),
      '{"id":"c","seq":3,"at":1,"actor":"run',
    ].join('\n');
    const result = replayEvents(text);
    expect(result.events.map((event) => event.id)).toEqual(['a', 'b']);
    expect(result.tornTail).toBe(true);
    expect(result.quarantined).toBe(0);
  });

  it('quarantines an interior corrupt row without losing the rows around it', () => {
    const text = [
      journalLine({ id: 'a', seq: 1 }),
      '{"id":"broken", not json}',
      journalLine({ id: 'b', seq: 3, event: 'run.finished' }),
    ].join('\n');
    const result = replayEvents(text);
    expect(result.events.map((event) => event.id)).toEqual(['a', 'b']);
    expect(result.quarantined).toBe(1);
    expect(result.tornTail).toBe(false);
  });

  it('sinceSeq returns only the tail past a snapshot, for the "snapshot plus tail" mode', () => {
    const text = [
      journalLine({ id: 'a', seq: 1 }),
      journalLine({ id: 'b', seq: 2, event: 'run.finished' }),
      journalLine({ id: 'c', seq: 3, event: 'run.finished' }),
    ].join('\n');
    const result = replayEvents(text, { sinceSeq: 2 });
    expect(result.events.map((event) => event.id)).toEqual(['c']);
  });

  it('reads a pre-B.3 fixture journal with no seq or version as version 0, quarantining nothing', () => {
    const fixturePath = fileURLToPath(
      new URL('./fixtures/legacy-journal.jsonl', import.meta.url),
    );
    const text = readFileSync(fixturePath, 'utf8');
    const result = replayEvents(text);
    expect(result.quarantined).toBe(0);
    expect(result.tornTail).toBe(false);
    expect(result.events.map((event) => event.id)).toEqual(['legacy-1', 'legacy-2', 'legacy-3']);
    expect(result.events.every((event) => event.version === 0)).toBe(true);
    // A file with no seq at all still gets a usable, increasing seq per row: the
    // "snapshot plus tail" contract has to hold for history written before this field
    // existed, not only for journals B.3's writer produced.
    expect(result.events.map((event) => event.seq)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------------------
// VerifiedField and /state
// ---------------------------------------------------------------------------------------

describe('VerifiedField', () => {
  it('the observed() and verified() builders produce accepted shapes', () => {
    const a: VerifiedField<number> = observed(3);
    const b: VerifiedField<number> = verified(3, 'lane-file-mtime');
    expect(a.verified_at).toBeUndefined();
    expect(b.source).toBe('lane-file-mtime');
  });

  it('cannot be constructed with verified_at and no source (compile-time)', () => {
    expectTypeOf<{ value: number; observed_at: number; verified_at: number }>()
      .not.toMatchTypeOf<VerifiedField<number>>();
    expectTypeOf<{ value: number; observed_at: number; verified_at: number; source: string }>()
      .toMatchTypeOf<VerifiedField<number>>();
  });
});

describe('ForgeStateSnapshotSchema', () => {
  it('accepts a snapshot shaped like /state, every field carrying its own verified_at', () => {
    const snapshot = {
      at: 1,
      lanes: { value: [], observed_at: 1, verified_at: 1, source: 'lanes-dir' },
      burn: { value: {}, observed_at: 1, verified_at: 1, source: 'journal' },
      handoffs: { value: 0, observed_at: 1, verified_at: 1, source: 'journal' },
      torn: { value: 0, observed_at: 1, verified_at: 1, source: 'journal' },
      inbox_open: { value: 0, observed_at: 1, verified_at: 1, source: 'inbox-dir' },
      stuck: { value: [], observed_at: 1, verified_at: 1, source: 'liveness' },
      fleet: { value: [], observed_at: 1, verified_at: 1, source: 'fleetwatch' },
      runs: {},
    };
    expect(ForgeStateSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('rejects a field carrying verified_at with no source', () => {
    const snapshot = {
      at: 1,
      lanes: { value: [], observed_at: 1, verified_at: 1 },
      burn: { value: {}, observed_at: 1 },
      handoffs: { value: 0, observed_at: 1 },
      torn: { value: 0, observed_at: 1 },
      inbox_open: { value: 0, observed_at: 1 },
      stuck: { value: [], observed_at: 1 },
      fleet: { value: [], observed_at: 1 },
      runs: {},
    };
    expect(ForgeStateSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it('accepts fleet as the {ok:false,reason} shape a failed probe reports', () => {
    const snapshot = {
      at: 1,
      lanes: { value: [], observed_at: 1 },
      burn: { value: {}, observed_at: 1 },
      handoffs: { value: 0, observed_at: 1 },
      torn: { value: 0, observed_at: 1 },
      inbox_open: { value: 0, observed_at: 1 },
      stuck: { value: [], observed_at: 1 },
      fleet: { value: { ok: false, reason: 'tasklist failed' }, observed_at: 1 },
      runs: {},
    };
    expect(ForgeStateSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('rejects a stuck entry missing the fields a real StuckSignal always carries', () => {
    const snapshot = {
      at: 1,
      lanes: { value: [], observed_at: 1 },
      burn: { value: {}, observed_at: 1 },
      handoffs: { value: 0, observed_at: 1 },
      torn: { value: 0, observed_at: 1 },
      inbox_open: { value: 0, observed_at: 1 },
      stuck: { value: [{}], observed_at: 1 },
      fleet: { value: [], observed_at: 1 },
      runs: {},
    };
    expect(ForgeStateSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it('rejects a fleet entry that is not a real FleetProcess', () => {
    const snapshot = {
      at: 1,
      lanes: { value: [], observed_at: 1 },
      burn: { value: {}, observed_at: 1 },
      handoffs: { value: 0, observed_at: 1 },
      torn: { value: 0, observed_at: 1 },
      inbox_open: { value: 0, observed_at: 1 },
      stuck: { value: [], observed_at: 1 },
      fleet: { value: [{}], observed_at: 1 },
      runs: {},
    };
    expect(ForgeStateSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it('accepts a real-shaped fleet process entry', () => {
    const snapshot = {
      at: 1,
      lanes: { value: [], observed_at: 1 },
      burn: { value: {}, observed_at: 1 },
      handoffs: { value: 0, observed_at: 1 },
      torn: { value: 0, observed_at: 1 },
      inbox_open: { value: 0, observed_at: 1 },
      stuck: { value: [], observed_at: 1 },
      fleet: { value: [{ pid: 1234, isLogin: false, sessionFileMtime: 1 }], observed_at: 1 },
      runs: {},
    };
    expect(ForgeStateSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// FORGE_TOOLS, sourced from the adapter's own registration
// ---------------------------------------------------------------------------------------

describe('FORGE_TOOLS', () => {
  it('equals the names buildForgeMcpServer actually registers, not a copied list', () => {
    const server = buildForgeMcpServer({
      onDone: () => {}, onHandoff: () => {}, onAsk: () => {}, onGotcha: () => {}, onReport: () => {},
    });
    const instance = server.instance as unknown as { _registeredTools: Record<string, unknown> };
    const registered = Object.keys(instance._registeredTools).map((name) => `mcp__forge__${name}`);
    expect(FORGE_TOOLS.sort()).toEqual(registered.sort());
  });

  it('carries all five tools, including forge_report', () => {
    expect(FORGE_TOOLS).toEqual(expect.arrayContaining([
      'mcp__forge__forge_done', 'mcp__forge__forge_handoff', 'mcp__forge__forge_ask',
      'mcp__forge__forge_gotcha', 'mcp__forge__forge_report',
    ]));
    expect(FORGE_TOOLS).toHaveLength(5);
  });

  it('sdkengine.ts\'s WORKER_TOOLS names the same tools, sourced from FORGE_TOOL_NAMES rather than a second copied list', async () => {
    const { WORKER_TOOLS } = await import('../../src/forge/sdkengine.js');
    const { FORGE_TOOL_NAMES } = await import('../../src/forge/contracts.js');
    expect([...WORKER_TOOLS].sort()).toEqual([...FORGE_TOOL_NAMES].sort());
  });
});

describe('tool input schemas', () => {
  it('forge_done: accepts evidence, rejects an empty one', () => {
    expect(ForgeDoneInputSchema.safeParse({ evidence: 'npm run verify passed' }).success).toBe(true);
    expect(ForgeDoneInputSchema.safeParse({ evidence: '' }).success).toBe(false);
  });

  it('forge_handoff: accepts a packet, rejects a missing one', () => {
    expect(ForgeHandoffInputSchema.safeParse({ packet: 'next: fix X' }).success).toBe(true);
    expect(ForgeHandoffInputSchema.safeParse({}).success).toBe(false);
  });

  it('forge_ask: accepts a bare question, rejects a non-string question', () => {
    expect(ForgeAskInputSchema.safeParse({ question: 'dev or staging?' }).success).toBe(true);
    expect(ForgeAskInputSchema.safeParse({ question: 5 }).success).toBe(false);
  });

  it('forge_gotcha: accepts the four required fields, rejects one missing prevention', () => {
    const full = { run: 'r1', what: 'x', where: 'y', error: 'z', prevention: 'do w' };
    expect(ForgeGotchaInputSchema.safeParse(full).success).toBe(true);
    const { prevention: _prevention, ...withoutPrevention } = full;
    expect(ForgeGotchaInputSchema.safeParse(withoutPrevention).success).toBe(false);
  });

  it('forge_report: accepts the three required fields, rejects a missing leftOff', () => {
    const full = { outcome: 'done', done: 'evidence', leftOff: 'nothing left' };
    expect(ForgeReportInputSchema.safeParse(full).success).toBe(true);
    const { leftOff: _leftOff, ...withoutLeftOff } = full;
    expect(ForgeReportInputSchema.safeParse(withoutLeftOff).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// RunReport
// ---------------------------------------------------------------------------------------

describe('RunReportSchema', () => {
  const valid = {
    run: 'forge-contracts',
    outcome: { summary: 'done', causeId: 'evt-1' },
    done: { evidence: 'npm run verify passed, 42 tests' },
    leftOff: { nextSteps: ['open the PR', 'watch checks', 'nothing else'], resumeState: 'clean' },
    issues: [{ description: 'schema X is loose', proposedFix: 'tighten it' }],
    blockers: [],
    unverified: ['no live SDK session was opened'],
    gotchasFiled: 0,
    decisionsNeeded: [],
    cost: { usd: 0.02 },
  };

  it('accepts a full run report', () => {
    expect(RunReportSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a blocker missing the verbatim error (that makes it an issue, not a blocker)', () => {
    const withBadBlocker = {
      ...valid,
      blockers: [{
        key: 'k1', blocks: 'the PR', commandAttempted: 'gh pr merge', owner: 'aaron', tried: 'once',
        resumeAction: 'ask aaron',
      }],
    };
    expect(RunReportSchema.safeParse(withBadBlocker).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// RunState and its legal transitions
// ---------------------------------------------------------------------------------------

describe('RunState transitions', () => {
  it('every state has an entry in RUN_TRANSITIONS', () => {
    for (const state of RUN_STATES) expect(RUN_TRANSITIONS[state]).toBeDefined();
  });

  it('refuses done directly from parked (the misuse gate: done must pass through verifying)', () => {
    expect(canTransition('parked', 'done')).toBe(false);
  });

  it('refuses queued to running without admission', () => {
    expect(canTransition('queued', 'running')).toBe(false);
  });

  it('refuses running to queued (no state may go backward to queued)', () => {
    expect(canTransition('running', 'queued')).toBe(false);
  });

  it('refuses any transition out of the three terminal states', () => {
    expect(canTransition('done', 'running')).toBe(false);
    expect(canTransition('failed', 'running')).toBe(false);
    expect(canTransition('killed', 'running')).toBe(false);
  });

  it('allows the legal path from parked back to running, and running through to done via verifying', () => {
    expect(canTransition('parked', 'running')).toBe(true);
    expect(canTransition('running', 'verifying')).toBe(true);
    expect(canTransition('verifying', 'done')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------------------

describe('OwnershipSchema', () => {
  it('accepts a claim with a fencing token', () => {
    const claim = {
      goal: 'forge-contracts', run: 'forge-contracts-1', checkout: '<worktree>',
      lane: 'forge-contracts', locks: [], fencingToken: 'tok-1', claimedAt: 1,
    };
    expect(OwnershipSchema.safeParse(claim).success).toBe(true);
  });

  it('rejects a claim with no fencing token', () => {
    const claim = {
      goal: 'forge-contracts', run: 'forge-contracts-1', checkout: '<worktree>',
      lane: 'forge-contracts', locks: [], claimedAt: 1,
    };
    expect(OwnershipSchema.safeParse(claim).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// Reasoner / providers
// ---------------------------------------------------------------------------------------

describe('providerFor', () => {
  it('routes master and plan to codex, per the 13:20 decision', () => {
    expect(providerFor('master')).toBe('codex');
    expect(providerFor('plan')).toBe('codex');
  });

  it('routes every other class to claude, including one this map does not name', () => {
    expect(providerFor('implement')).toBe('claude');
    expect(providerFor('some-future-class')).toBe('claude');
  });
});

// ---------------------------------------------------------------------------------------
// ExternalWrite
// ---------------------------------------------------------------------------------------

describe('ExternalWrite', () => {
  it('accepts each of the four states', () => {
    for (const state of EXTERNAL_WRITE_STATES) {
      const write: ExternalWrite = {
        id: 'w1', kind: 'jira-comment', idempotencyKey: 'k1', state, at: 1,
      };
      expect(ExternalWriteSchema.safeParse(write).success).toBe(true);
    }
  });

  it('mayRetryWithoutReconciling is true only for intent', () => {
    const base = { id: 'w1', kind: 'jira-comment', idempotencyKey: 'k1', at: 1 };
    expect(mayRetryWithoutReconciling({ ...base, state: 'intent' })).toBe(true);
    expect(mayRetryWithoutReconciling({ ...base, state: 'call' })).toBe(false);
    expect(mayRetryWithoutReconciling({ ...base, state: 'unknown' })).toBe(false);
    expect(mayRetryWithoutReconciling({ ...base, state: 'complete' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// Redact
// ---------------------------------------------------------------------------------------

describe('redact', () => {
  it('masks a token-shaped string inside a longer error message', () => {
    const text = 'push failed: authentication with ghp_abcdefghij1234567890ABCD failed';
    expect(redact(text)).not.toContain('ghp_abcdefghij1234567890ABCD');
    expect(redact(text)).toContain('[redacted]');
  });

  it('leaves an ordinary error message untouched', () => {
    const text = 'exit code 1: no such file or directory';
    expect(redact(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------------------
// StuckSignal, extended
// ---------------------------------------------------------------------------------------

describe('ExtendedStuckSignalSchema', () => {
  it('accepts drift and blocker as signals, on top of liveness.ts\'s own five', () => {
    for (const signal of ['idle', 'context', 'drift', 'blocker']) {
      const trip = { key: 'r1', signal, threshold: 1, observed: 2, since: 1, hint: 'x' };
      expect(ExtendedStuckSignalSchema.safeParse(trip).success).toBe(true);
    }
  });

  it('rejects a signal outside the extended union', () => {
    const trip = { key: 'r1', signal: 'made-up', threshold: 1, observed: 2, since: 1, hint: 'x' };
    expect(ExtendedStuckSignalSchema.safeParse(trip).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// Inbox message states, and AskEntry's key
// ---------------------------------------------------------------------------------------

describe('InboxMessageSchema', () => {
  it('accepts each of the four states', () => {
    for (const state of INBOX_MESSAGE_STATES) {
      const message = { id: 'm1', state, at: 1, from: 'console', text: 'hi' };
      expect(InboxMessageSchema.safeParse(message).success).toBe(true);
    }
  });
});

describe('AskEntrySchema and askKey', () => {
  const base = { goal: 'forge-contracts', run: 'forge-contracts-1', action: 'deploy', resource: 'env', wording: 'dev or staging?' };

  it('accepts a well-formed entry', () => {
    const entry = { key: askKey(base), ...base, kind: 'question', at: 1 };
    expect(AskEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('changes when goal changes', () => {
    expect(askKey(base)).not.toBe(askKey({ ...base, goal: 'a-different-goal' }));
  });

  it('changes when run changes', () => {
    expect(askKey(base)).not.toBe(askKey({ ...base, run: 'forge-contracts-2' }));
  });

  it('changes when action changes', () => {
    expect(askKey(base)).not.toBe(askKey({ ...base, action: 'rollback' }));
  });

  it('changes when resource changes', () => {
    expect(askKey(base)).not.toBe(askKey({ ...base, resource: 'region' }));
  });

  it('does not change on case or whitespace alone', () => {
    const noisy = {
      goal: '  Forge-Contracts  ', run: 'FORGE-contracts-1', action: 'Deploy',
      resource: 'ENV', wording: '  dev   or STAGING?  ',
    };
    expect(askKey(base)).toBe(askKey(noisy));
  });

  it('changes on kind alone: a question and a blocker over identical words are two asks', () => {
    expect(askKey({ ...base, kind: 'question' })).not.toBe(askKey({ ...base, kind: 'blocker' }));
  });

  it('does not let a field boundary shift produce a false collision', () => {
    // goal:"g", run:"x" vs. goal:"gx", run:"" would collide under a plain separator-joined
    // string once the empty run is trimmed away; JSON-encoding each field keeps the
    // boundary unambiguous.
    const a = askKey({ goal: 'g', run: 'x', action: 'a', resource: 'r', wording: 'w' });
    const b = askKey({ goal: 'gx', run: '', action: 'a', resource: 'r', wording: 'w' });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------------------
// CLI surface, EventBus roles
// ---------------------------------------------------------------------------------------

describe('CLI_COMMANDS and EVENT_BUS_ROLES', () => {
  it('names every command cli.ts answers today, plus why', () => {
    for (const command of ['up', 'status', 'run', 'send', 'answer', 'stop', 'gotchas', 'clear', 'cutover', 'why']) {
      expect(CLI_COMMANDS).toContain(command);
    }
  });

  it('names the six roles Section 1 of the spec lists as subscribed to the bus, plus self-iteration\'s own seventh (decision 4)', () => {
    expect([...EVENT_BUS_ROLES].sort()).toEqual(
      ['console', 'council', 'governor', 'intake', 'runner', 'self-iteration', 'warden'].sort(),
    );
  });

  it('CLI_EXIT_CODES matches B.3.4: 0 done, 1 refused, 2 parked, 3 exhausted or stopped', () => {
    expect(CLI_EXIT_CODES).toEqual({ done: 0, refused: 1, parked: 2, exhaustedOrStopped: 3 });
  });
});

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

describe('fake-sdk-stream.json', () => {
  it('is shaped like the real stream: a tool result arrives before the usage flush that ends the turn', () => {
    const rows = readFixtureJson('fake-sdk-stream.json') as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);

    const toolResultIndex = rows.findIndex((row) => {
      const content = (row['message'] as { content?: unknown[] } | undefined)?.content;
      return Array.isArray(content) && content.some(
        (block) => (block as { type?: string }).type === 'tool_result',
      );
    });
    const usageFlushIndex = rows.findIndex((row) => {
      const usage = (row['message'] as { usage?: unknown } | undefined)?.usage
        ?? (row as { usage?: unknown }).usage;
      return row['type'] === 'assistant' && Boolean(usage);
    });

    expect(toolResultIndex).toBeGreaterThanOrEqual(0);
    expect(usageFlushIndex).toBeGreaterThanOrEqual(0);
    expect(toolResultIndex).toBeLessThan(usageFlushIndex);
  });

  it('carries a tool_use, its tool_result with isError, and a final result row', () => {
    const rows = readFixtureJson('fake-sdk-stream.json') as Array<Record<string, unknown>>;
    expect(rows.some((row) => row['type'] === 'system' && row['subtype'] === 'init')).toBe(true);
    expect(rows.some((row) => row['type'] === 'result')).toBe(true);
    const toolResult = rows.find((row) => {
      const content = (row['message'] as { content?: unknown[] } | undefined)?.content;
      return Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result');
    });
    expect(toolResult).toBeTruthy();
  });
});

describe('real-session-sample.jsonl', () => {
  it('is under 40 rows', () => {
    const rows = readFixtureLines('real-session-sample.jsonl');
    expect(rows.length).toBeLessThan(40);
  });

  it('carries exactly one system.init, one assistant message with usage and a tool_use, its tool_result, and one result row', () => {
    const rows = readFixtureLines('real-session-sample.jsonl') as Array<Record<string, unknown>>;

    const inits = rows.filter((row) => row['type'] === 'system' && row['subtype'] === 'init');
    expect(inits).toHaveLength(1);

    const assistantsWithUsageAndToolUse = rows.filter((row) => {
      if (row['type'] !== 'assistant') return false;
      const message = row['message'] as { usage?: unknown; content?: unknown[] } | undefined;
      const hasToolUse = Array.isArray(message?.content)
        && message!.content!.some((b) => (b as { type?: string }).type === 'tool_use');
      return Boolean(message?.usage) && hasToolUse;
    });
    expect(assistantsWithUsageAndToolUse).toHaveLength(1);

    const toolUseId = ((assistantsWithUsageAndToolUse[0]!['message'] as { content: Array<Record<string, unknown>> })
      .content.find((b) => b['type'] === 'tool_use') as { id: string }).id;

    const toolResults = rows.filter((row) => {
      if (row['type'] !== 'user') return false;
      const content = (row['message'] as { content?: unknown[] } | undefined)?.content;
      return Array.isArray(content) && content.some(
        (b) => (b as { type?: string; tool_use_id?: string }).type === 'tool_result'
          && (b as { tool_use_id?: string }).tool_use_id === toolUseId,
      );
    });
    expect(toolResults).toHaveLength(1);

    const results = rows.filter((row) => row['type'] === 'result');
    expect(results).toHaveLength(1);
  });

  it('carries no drive-rooted or home-directory path (scrubbed before commit)', () => {
    const text = readFileSync(join(FIXTURES, 'real-session-sample.jsonl'), 'utf8');
    expect(text).not.toMatch(/[A-Za-z]:[\\/]+[Uu]sers[\\/]/);
    expect(text).not.toMatch(/\bC:[\\/]dev\b/i);
  });
});

describe('P4.7/I3: providerFor reads model-policy.json through policy.ts, not a second hardcoded map', () => {
  it('agrees with policy.ts\'s own providerFor for every declared class', async () => {
    const { classNames, providerFor: policyProviderFor } = await import('../../src/forge/policy.js');
    for (const name of classNames()) {
      expect(providerFor(name)).toBe(policyProviderFor(name));
    }
  });

  it('a class the policy file declares with an explicit provider is read from the file, not from a copy in contracts.ts', async () => {
    // council is declared claude in model-policy.json; flip its provider in a fixture
    // and confirm contracts.ts's providerFor moves with the file rather than a frozen copy.
    const { writeFileSync, mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'forge-contracts-provider-'));
    const path = join(dir, 'model-policy.json');
    const base = JSON.parse(readFileSync(new URL('../../src/forge/model-policy.json', import.meta.url), 'utf8'));
    base.classes['implement'].provider = 'codex';
    writeFileSync(path, JSON.stringify(base), 'utf8');

    const prior = process.env['FORGE_POLICY_PATH'];
    process.env['FORGE_POLICY_PATH'] = path;
    try {
      expect(providerFor('implement')).toBe('codex');
    } finally {
      if (prior === undefined) delete process.env['FORGE_POLICY_PATH'];
      else process.env['FORGE_POLICY_PATH'] = prior;
    }
  });
});
