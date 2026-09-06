/**
 * The stub server's seed lanes: the same 13-lane, one-of-each-state board the
 * prototype shipped with, reproduced with generic ids (`check:agnostic` refuses
 * a ticket-key style that looks like a real project's prefix).
 */
import type { Lane } from '../../shared/console-model.js';

const T0 = Date.parse('2026-01-06T14:07:52Z');

function lane(partial: Partial<Lane> & Pick<Lane, 'id' | 'state'>): Lane {
  return {
    ticket: null,
    model: 'sonnet-5',
    modelId: 'claude-sonnet-5',
    className: 'implement',
    repo: 'flightdeck-api',
    attempt: 1,
    reason: null,
    stepN: 1,
    stepTotal: 6,
    stepText: 'working',
    ctxTokens: 40_000,
    ctxCeiling: 200_000,
    ctxCompactAt: 180_000,
    costUsd: 1.2,
    capUsd: 20,
    burnUsdPerMin: 0,
    fails: 0,
    hop: 2,
    hopStatus: 'live',
    observedAt: T0,
    verifiedAt: T0,
    heart: false,
    since: T0,
    startedAt: T0,
    endedAt: null,
    question: null,
    pr: null,
    sandbox: null,
    blockedBy: null,
    runaway: false,
    needsAaron: null,
    ...partial,
  };
}

export function seedLanes(): Lane[] {
  const now = Date.now();
  return [
    lane({
      id: 'FLT-201', ticket: 'FLT-201', state: 'running', heart: true, hop: 2, hopStatus: 'live',
      stepN: 3, stepTotal: 6, stepText: 'writing the withdrawal-fee integration test',
      ctxTokens: 86_000, costUsd: 4.32, capUsd: 20, burnUsdPerMin: 0.09,
      observedAt: now - 3_000, verifiedAt: now - 3_000, since: now - 42 * 60_000, startedAt: now - 42 * 60_000,
      sandbox: { id: 'fd-2201', path: null, branch: 'feature/flt-201', pid: 44821, sessionId: 'sess-9f21' },
    }),
    lane({
      id: 'BBZ-118', ticket: 'BBZ-118', state: 'parked', heart: false, hop: 2, hopStatus: 'blocked',
      stepN: 4, stepTotal: 6, stepText: 'blocked on a schema question',
      ctxTokens: 141_000, costUsd: 11.06, capUsd: 20,
      observedAt: now - 8 * 60_000, verifiedAt: now - 8 * 60_000, since: now - 8 * 60_000,
      startedAt: now - 3 * 3_600_000,
      question: {
        key: 'ask-bbz-118', text: 'the migration column should be NOT NULL or nullable with a backfill job?',
        opts: ['NOT NULL', 'nullable + backfill', 'abort the migration'], askedAt: now - 8 * 60_000,
      },
    }),
    lane({
      id: 'FLT-204', ticket: 'FLT-204', state: 'running', heart: true, runaway: true, hop: 2, hopStatus: 'live',
      stepN: 2, stepTotal: 6, stepText: 'retrying a flaky build step',
      ctxTokens: 70_000, costUsd: 27.5, capUsd: 8, burnUsdPerMin: 1.3, fails: 2,
      observedAt: now - 2_000, verifiedAt: now - 2_000, since: now - 30 * 60_000, startedAt: now - 30 * 60_000,
    }),
    lane({
      id: 'FLT-199', ticket: 'FLT-199', state: 'handed-off', heart: true, hop: 3, hopStatus: 'live',
      stepN: 6, stepTotal: 6, stepText: 'handed off to the gate council',
      ctxTokens: 120_000, costUsd: 6.9, capUsd: 20,
      observedAt: now - 10_000, verifiedAt: now - 10_000, since: now - 5 * 60_000, startedAt: now - 60 * 60_000,
    }),
    lane({
      id: 'FLT-187', ticket: 'FLT-187', state: 'paused', heart: false, hop: 2, hopStatus: 'live',
      stepN: 2, stepTotal: 6, stepText: 'paused by the operator',
      ctxTokens: 55_000, costUsd: 2.1, capUsd: 20,
      observedAt: now - 20 * 60_000, verifiedAt: null, since: now - 20 * 60_000, startedAt: now - 90 * 60_000,
    }),
    lane({
      id: 'FLT-190', ticket: 'FLT-190', state: 'merged', heart: false, hop: 5, hopStatus: 'done',
      stepN: 6, stepTotal: 6, stepText: 'merged',
      ctxTokens: 95_000, costUsd: 8.4, capUsd: 20,
      observedAt: now - 40 * 60_000, verifiedAt: null, since: now - 40 * 60_000, startedAt: now - 2 * 3_600_000,
      pr: { no: 214, url: 'https://example.invalid/pr/214', files: 6, add: 140, del: 22, draft: false },
    }),
    lane({
      id: 'FLT-193', ticket: 'FLT-193', state: 'done', heart: false, hop: 4, hopStatus: 'done',
      stepN: 6, stepTotal: 6, stepText: 'ready to merge',
      ctxTokens: 88_000, costUsd: 5.6, capUsd: 20,
      observedAt: now - 12 * 60_000, verifiedAt: null, since: now - 12 * 60_000, startedAt: now - 3_600_000,
      pr: { no: 231, url: 'https://example.invalid/pr/231', files: 4, add: 88, del: 10, draft: false },
    }),
    lane({
      id: 'FLT-181', ticket: 'FLT-181', state: 'blocked', heart: false, hop: 3, hopStatus: 'blocked',
      stepN: 5, stepTotal: 6, stepText: 'the gate council failed this attempt',
      reason: 'gate: FIX FIRST -- 2 critical findings',
      ctxTokens: 130_000, costUsd: 9.2, capUsd: 20,
      observedAt: now - 25 * 60_000, verifiedAt: null, since: now - 25 * 60_000, startedAt: now - 4 * 3_600_000,
    }),
    lane({
      id: 'FLT-176', ticket: 'FLT-176', state: 'exhausted', heart: false, hop: 2, hopStatus: 'blocked',
      stepN: 6, stepTotal: 6, stepText: 'ran out of context before finishing',
      ctxTokens: 198_000, costUsd: 14.8, capUsd: 20,
      observedAt: now - 50 * 60_000, verifiedAt: null, since: now - 50 * 60_000, startedAt: now - 5 * 3_600_000,
    }),
    lane({
      id: 'FLT-168', ticket: 'FLT-168', state: 'unverified', heart: false, hop: 3, hopStatus: 'blocked',
      stepN: 6, stepTotal: 6, stepText: 'finished without a gate verdict',
      ctxTokens: 60_000, costUsd: 3.4, capUsd: 20,
      observedAt: now - 90 * 60_000, verifiedAt: null, since: now - 90 * 60_000, startedAt: now - 6 * 3_600_000,
    }),
    lane({
      id: 'FLT-211', ticket: 'FLT-211', state: 'blocked', heart: false, hop: 1, hopStatus: 'blocked',
      stepN: 1, stepTotal: 6, stepText: 'waiting on the AWS integration',
      reason: 'blocked on integration:aws', blockedBy: 'aws',
      ctxTokens: 5_000, costUsd: 0.2, capUsd: 20,
      observedAt: now - 15 * 60_000, verifiedAt: null, since: now - 15 * 60_000, startedAt: now - 15 * 60_000,
    }),
    lane({
      id: 'FLT-212', ticket: 'FLT-212', state: 'blocked', heart: false, hop: 1, hopStatus: 'blocked',
      stepN: 1, stepTotal: 6, stepText: 'waiting on the AWS integration',
      reason: 'blocked on integration:aws', blockedBy: 'aws',
      ctxTokens: 4_000, costUsd: 0.15, capUsd: 20,
      observedAt: now - 15 * 60_000, verifiedAt: null, since: now - 15 * 60_000, startedAt: now - 15 * 60_000,
    }),
    lane({
      id: 'FLT-213', ticket: 'FLT-213', state: 'blocked', heart: false, hop: 1, hopStatus: 'blocked',
      stepN: 1, stepTotal: 6, stepText: 'waiting on the AWS integration',
      reason: 'blocked on integration:aws', blockedBy: 'aws',
      ctxTokens: 6_000, costUsd: 0.25, capUsd: 20,
      observedAt: now - 15 * 60_000, verifiedAt: null, since: now - 15 * 60_000, startedAt: now - 15 * 60_000,
    }),
    // A run whose id is the long jira_<TICKET>_<epoch-ms> style the real fleet
    // uses, and whose ticket differs from its id -- POLISH-2 #1's headline rule.
    lane({
      id: 'jira_AB-12_1788460932645', ticket: 'AB-12', state: 'running', heart: true, hop: 2, hopStatus: 'live',
      repo: 'flightdeck-rn',
      stepN: 2, stepTotal: 6, stepText: 'wiring the webhook retry',
      ctxTokens: 30_000, costUsd: 0.8, capUsd: 20, burnUsdPerMin: 0.05,
      observedAt: now - 5_000, verifiedAt: now - 5_000, since: now - 10 * 60_000, startedAt: now - 10 * 60_000,
    }),
  ];
}
