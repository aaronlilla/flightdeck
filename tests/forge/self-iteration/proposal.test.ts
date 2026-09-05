/**
 * Proposals ship as draft PRs, never merged, never activated (roadmap P4.6). Every
 * proposal body passes through `Redact` before it reaches a fake `gh pr create` call,
 * mirroring `council/redact-sinks.ts`'s own three sinks.
 */
import { describe, expect, it } from 'vitest';

import type { Cluster } from '../../../src/forge/self-iteration/cluster.js';
import {
  buildProposal, planProposalIntent, recordProposalCall, reconcileProposalCall,
} from '../../../src/forge/self-iteration/proposal.js';

const CLUSTER: Cluster = {
  id: 'cluster-1', key: 'k', toolName: 'npm', normalizedError: 'boom', frames: [],
  gotchaIds: ['g1', 'g2'], causeSummary: 'npm: boom',
};

describe('buildProposal: draft-only, refuses on a protected-capability denial', () => {
  it('refuses to become a proposal at all when the classifier denies the diff', () => {
    const outcome = buildProposal(CLUSTER, 'touches a guard', {
      allow: false, capability: 'permission', reason: 'touches hooks', matched: 'hooks/x.py',
    });
    expect(outcome.proposed).toBe(false);
  });

  it('a proposal never carries any action but open-draft-pr, and is marked dormant', () => {
    const outcome = buildProposal(CLUSTER, 'a summary of the diff', { allow: true });
    expect(outcome.proposed).toBe(true);
    if (outcome.proposed) {
      expect(outcome.proposal.action).toBe('open-draft-pr');
      expect(outcome.proposal.dormant).toBe(true);
    }
  });

  it('redacts a secret out of the proposal body before a faked gh pr create call ever sees it (JWT-shaped fixture)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc2lzYWZha2VzaWduYXR1cmU';
    const outcome = buildProposal(CLUSTER, `evidence carried a token: ${jwt}`, { allow: true });
    expect(outcome.proposed).toBe(true);

    // The actual string a faked gh call would receive.
    const fakeCall = (input: { body: string }) => input.body;
    const sentBody = outcome.proposed ? fakeCall({ body: outcome.proposal.body }) : '';

    expect(sentBody).not.toContain(jwt);
    expect(sentBody).toContain('[redacted]');
  });

  it('redacts an sk-shaped secret the same way', () => {
    const secret = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX';
    const outcome = buildProposal(CLUSTER, `leaked ${secret} in the traceback`, { allow: true });
    const body = outcome.proposed ? outcome.proposal.body : '';
    expect(body).not.toContain(secret);
  });
});

describe('the ExternalWrite lifecycle for a draft PR', () => {
  it('never reconciles to complete on a merged PR -- this module never intends a merge', () => {
    const outcome = buildProposal(CLUSTER, 'summary', { allow: true });
    if (!outcome.proposed) throw new Error('expected a proposal');
    const intent = planProposalIntent(outcome.proposal);
    const call = recordProposalCall(intent);
    const reconciled = reconcileProposalCall(call, { prState: 'MERGED', isDraft: false });
    expect(reconciled.state).toBe('unknown');
  });

  it('reconciles to complete only on an open draft PR', () => {
    const outcome = buildProposal(CLUSTER, 'summary', { allow: true });
    if (!outcome.proposed) throw new Error('expected a proposal');
    const intent = planProposalIntent(outcome.proposal);
    const call = recordProposalCall(intent);
    const reconciled = reconcileProposalCall(call, { prState: 'OPEN', isDraft: true });
    expect(reconciled.state).toBe('complete');
  });
});
