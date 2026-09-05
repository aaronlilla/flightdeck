/**
 * Dispatcher decision 3: when a merged proposal's canary fails after merge, this opens a
 * revert PR through the same `ExternalWrite` intent/call/complete path Council's own
 * merge writes use -- it never reverts automatically, and a person merges the revert
 * the same way a person merges anything else. The one row this module ever journals for
 * itself is `proposal.reverted-requested`; there is no `proposal.reverted` event, because
 * this code is never the thing that closes that loop.
 */
import { createHash } from 'node:crypto';

import { redact, type ExternalWrite, type ForgeEventEnvelope } from '../contracts.js';

export interface RevertSubject {
  repo: string;
  pr: number;
  headSha: string;
}

export interface RevertRequest {
  subject: RevertSubject;
  body: string;
}

function idempotencyKeyFor(subject: RevertSubject): string {
  return createHash('sha256').update(`revert|${JSON.stringify(subject)}`).digest('hex').slice(0, 16);
}

/**
 * The failing rows go straight into the revert PR's body, redacted, so whoever merges
 * the revert can see exactly what the canary saw fail without having to go dig up the
 * journal themselves.
 */
export function buildRevertRequest(subject: RevertSubject, failingRows: ForgeEventEnvelope[]): RevertRequest {
  const rows = failingRows.map((row) => `- ${row.event} (run ${row.run ?? 'unknown'}): ${JSON.stringify(row)}`).join('\n');
  return {
    subject,
    body: redact(`Reverting ${subject.repo}#${subject.pr} at ${subject.headSha}: the post-merge canary failed.\n\n${rows}`),
  };
}

export function planRevertIntent(request: RevertRequest): ExternalWrite {
  return {
    id: `revert-${request.subject.repo}-${request.subject.pr}`,
    kind: 'pr-revert-request',
    idempotencyKey: idempotencyKeyFor(request.subject),
    state: 'intent',
    at: Date.now(),
  };
}

export function recordRevertCall(intent: ExternalWrite): ExternalWrite {
  return { ...intent, state: 'call', at: Date.now() };
}
