/**
 * Manual re-sync for the Errors/inbox page: pull the Jira inbox fresh and re-classify
 * it. No Sentry client exists in this codebase (`grep -ri sentry src/forge` finds
 * labels only), so the message says so plainly rather than implying a feed that isn't
 * wired -- Aaron chose this page name knowing that (R-13).
 */
import type { StageResult } from './sessions.js';

const NO_SENTRY_SENTENCE = 'Sentry: no client (R-13)';

export interface InboxCounts {
  open: number;
  resolved: number;
  dropped: number;
}

export interface SyncInboxDeps {
  fetch(): Promise<unknown[]>;
  classify(issues: unknown[]): InboxCounts;
}

export async function syncInbox(deps: SyncInboxDeps): Promise<StageResult> {
  let issues: unknown[];
  try {
    issues = await deps.fetch();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { counts: {}, message: reason };
  }
  const counts = deps.classify(issues);
  const countsSentence = `${counts.open} open, ${counts.resolved} resolved, ${counts.dropped} dropped.`;
  return {
    counts: { open: counts.open, resolved: counts.resolved, dropped: counts.dropped },
    message: `${countsSentence} ${NO_SENTRY_SENTENCE}`,
  };
}
