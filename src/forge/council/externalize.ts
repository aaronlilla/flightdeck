/**
 * Requirement: reconciliation before retry on every external write Council's gate makes,
 * via the `ExternalWrite` contract already declared in contracts.ts (decision 8). A merge
 * is a write to a system Forge does not control -- GitHub -- exactly like a Jira comment,
 * so it goes through the same intent/call/complete cycle rather than being treated as its
 * own unretryable action.
 */
import { createHash } from 'node:crypto';

import type { ExternalWrite } from '../contracts.ts';

export interface MergeSubject {
  repo: string;
  pr: number;
  headSha: string;
}

function idempotencyKeyFor(subject: MergeSubject): string {
  return createHash('sha256').update(JSON.stringify([subject.repo, subject.pr, subject.headSha])).digest('hex').slice(0, 16);
}

/** Recorded before the `gh pr merge` call is even attempted (decision 8). */
export function planMergeIntent(subject: MergeSubject): ExternalWrite {
  return {
    id: `merge-${subject.repo}-${subject.pr}-${subject.headSha}`,
    kind: 'pr-merge',
    idempotencyKey: idempotencyKeyFor(subject),
    state: 'intent',
    at: Date.now(),
  };
}

/** F5: recorded before the `gh pr ready` call, when a merge decision hits a draft PR.
 *  Its own kind (`pr-ready`) rather than folded into `pr-merge`, since it is a distinct
 *  external write with its own intent/call/complete row -- a passing gate is by
 *  construction what makes a draft ready, so this always precedes a merge intent, never
 *  replaces one. */
export function planReadyIntent(subject: MergeSubject): ExternalWrite {
  return {
    id: `ready-${subject.repo}-${subject.pr}-${subject.headSha}`,
    kind: 'pr-ready',
    idempotencyKey: idempotencyKeyFor(subject),
    state: 'intent',
    at: Date.now(),
  };
}

/** The `gh pr merge` (or `gh pr ready`) call was made. Its outcome is not yet known. */
export function recordMergeCall(intent: ExternalWrite): ExternalWrite {
  return { ...intent, state: 'call', at: Date.now() };
}

export interface GhPrView {
  prState: 'MERGED' | 'OPEN' | 'CLOSED';
}

/**
 * Reconciliation: read the PR before ever retrying the merge. `MERGED` is the only state
 * that resolves to `complete`; anything else stays `unknown` rather than being read as a
 * safe-to-retry `intent` -- a `gh pr view` that says OPEN does not prove the merge never
 * landed, it proves only that this read did not see it land.
 */
export function reconcileMerge(write: ExternalWrite, view: GhPrView): ExternalWrite {
  if (view.prState === 'MERGED') return { ...write, state: 'complete', at: Date.now() };
  return { ...write, state: 'unknown', at: Date.now() };
}
