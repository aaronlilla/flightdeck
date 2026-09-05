/**
 * Dispatcher decision 3: rollback never reverts automatically. It opens a revert PR
 * through the ExternalWrite intent/call path with the failing rows in the body, and a
 * person merges the revert. This module never journals a "reverted" completion, only
 * `proposal.reverted-requested` -- the caller is responsible for that row, and the
 * absence of any function here that could complete the revert is the point.
 */
import { describe, expect, it } from 'vitest';

import { asRunId, type ForgeEventEnvelope } from '../../../src/forge/contracts.js';
import { buildRevertRequest, planRevertIntent, recordRevertCall } from '../../../src/forge/self-iteration/rollback.js';

function envelope(overrides: Partial<Omit<ForgeEventEnvelope, 'run'>> & { run?: string }): ForgeEventEnvelope {
  const { run, ...rest } = overrides;
  return {
    id: 'e1', seq: 0, at: 1, event: 'run.blocked', actor: 'canary', version: 1,
    ...(run ? { run: asRunId(run) } : {}), ...rest,
  };
}

describe('buildRevertRequest', () => {
  it('carries the failing rows in the body', () => {
    const rows = [envelope({ event: 'run.blocked', run: 'r1' })];
    const request = buildRevertRequest({ repo: 'aaronlilla/flightdeck', pr: 12, headSha: 'abc123' }, rows);
    expect(request.body).toContain('r1');
    expect(request.body).toContain('run.blocked');
  });

  it('redacts a secret out of a failing row before it reaches the revert body', () => {
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const rows = [envelope({ event: 'run.blocked', run: 'r1', reason: `auth failed: ${secret}` })];
    const request = buildRevertRequest({ repo: 'aaronlilla/flightdeck', pr: 12, headSha: 'abc123' }, rows);
    expect(request.body).not.toContain(secret);
  });

  it('never carries the word "merge" as an action -- only a request', () => {
    const request = buildRevertRequest({ repo: 'r', pr: 1, headSha: 'x' }, []);
    const intent = planRevertIntent(request);
    expect(intent.kind).toBe('pr-revert-request');
  });
});

describe('the revert lifecycle stops at "call" -- nothing here completes it', () => {
  it('recordRevertCall only ever moves intent to call, never to complete', () => {
    const request = buildRevertRequest({ repo: 'r', pr: 1, headSha: 'x' }, []);
    const intent = planRevertIntent(request);
    expect(intent.state).toBe('intent');
    const call = recordRevertCall(intent);
    expect(call.state).toBe('call');
  });
});
