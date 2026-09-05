/**
 * The one thing this stream ever does to a repository: draft a pull request. Never a
 * merge, never a flag flip, never a file edited by this code outside a throwaway
 * worktree the canary owns for itself (`canary.ts`). "Proposals ship as draft PRs, never
 * merged, never activated" is the roadmap's own line for P4.6, and the shape below is
 * built so a caller cannot reach a merge from it even by accident: there is no function
 * here that turns a `Proposal` into anything but an `open-draft-pr` `ExternalWrite`,
 * mirroring `council/gate.ts`'s `backendGate`, which "does not even have an output shape
 * a caller could interpret as authorizing" one.
 */
import { createHash } from 'node:crypto';

import { redact, type ExternalWrite } from '../contracts.js';
import type { Cluster } from './cluster.js';
import type { CapabilityVerdict } from './classify.js';

export interface Proposal {
  id: string;
  clusterId: string;
  title: string;
  body: string;
  action: 'open-draft-pr';
  dormant: true;
}

export type ProposalOutcome =
  | { proposed: true; proposal: Proposal }
  | { proposed: false; reason: string };

/**
 * Refuses outright when the classifier denied the cluster's own diff -- a cluster whose
 * root cause lives in `src/forge/rules/` never becomes a proposal at all, regardless of
 * how green its specimens are, because a protected-capability denial is a "do not touch",
 * not a "touch it carefully."
 */
export function buildProposal(cluster: Cluster, diffSummary: string, classification: CapabilityVerdict): ProposalOutcome {
  if (!classification.allow) {
    return {
      proposed: false,
      reason: `${cluster.id} touches a protected capability (${classification.capability}): ${classification.reason}`,
    };
  }

  const body = redact(
    `Root cause: ${cluster.causeSummary}\n`
    + `Gotchas folded in: ${cluster.gotchaIds.join(', ')}\n\n`
    + `${diffSummary}\n\n`
    + 'This proposal is dormant: it opens as a draft only. Nothing merges it, and nothing '
    + 'activates it, until a person writes a decision.made row naming this proposal and '
    + 'activate.',
  );

  return {
    proposed: true,
    proposal: {
      id: `proposal-${cluster.id}`,
      clusterId: cluster.id,
      title: redact(`self-iteration: ${cluster.causeSummary}`).slice(0, 120),
      body,
      action: 'open-draft-pr',
      dormant: true,
    },
  };
}

function idempotencyKeyFor(proposal: Proposal): string {
  return createHash('sha256').update(proposal.id).digest('hex').slice(0, 16);
}

/** Recorded before any call is attempted, same intent/call/complete shape `externalize.ts`
 *  already uses for a merge: a draft PR is a write to a system Forge does not control. */
export function planProposalIntent(proposal: Proposal): ExternalWrite {
  return {
    id: `pr-draft-${proposal.id}`,
    kind: 'pr-draft',
    idempotencyKey: idempotencyKeyFor(proposal),
    state: 'intent',
    at: Date.now(),
  };
}

export function recordProposalCall(intent: ExternalWrite): ExternalWrite {
  return { ...intent, state: 'call', at: Date.now() };
}

export interface GhPrView {
  prState: 'MERGED' | 'OPEN' | 'CLOSED';
  isDraft: boolean;
}

/**
 * `OPEN` and still a draft is the only outcome this reconciles to `complete`. `MERGED`
 * reads as `unknown` here on purpose: nothing in this module ever intends a merge, so a
 * merged PR reconciling as `complete` would read as this code having succeeded at
 * something it was never supposed to attempt.
 */
export function reconcileProposalCall(write: ExternalWrite, view: GhPrView): ExternalWrite {
  if (view.prState === 'OPEN' && view.isDraft) return { ...write, state: 'complete', at: Date.now() };
  return { ...write, state: 'unknown', at: Date.now() };
}
