/**
 * J3: the three writes `forge gate --merge` makes once the merge itself is `complete`
 * and the PR's Haiping handoff names a ticket -- a comment in first person, an
 * assignment to QA when `FORGE_JIRA_QA_ACCOUNT` is set, and a transition when
 * `FORGE_JIRA_QA_TRANSITION` is set. Each is its own `ExternalWrite` kind
 * (`jira-comment`, `jira-assign`, `jira-transition`) carrying the same intent/call/
 * complete-or-unknown cycle `externalize.ts` already uses for the merge itself, so a
 * Jira failure here reads the same way a merge failure would, without ever touching the
 * merge's own row: the write this module makes is independent of, and always after,
 * the merge that already landed.
 */
import { createHash } from 'node:crypto';

import type { ExternalWrite, HaipingHandoff } from '../contracts.js';
import type { JiraCallResult, JiraWriteClient } from './jira.js';

/**
 * The comment posted on the handoff's ticket: deploy kind, both platform lines, the
 * steps, and what was not visually verified, in casual first person with no bolded
 * headers and no attribution -- the same register every Jira write in this codebase
 * goes out in.
 */
export function buildHandoffComment(haiping: HaipingHandoff, prUrl: string): string {
  const lines: string[] = [];
  lines.push(`Merged ${prUrl}.`);
  lines.push(
    haiping.deployKind === 'ota'
      ? 'This ships as an OTA update, no rebuild needed.'
      : 'This needs a fresh build to reach devices.',
  );
  lines.push(`Android: ${haiping.perPlatform.android}`);
  lines.push(`iOS: ${haiping.perPlatform.ios}`);
  if (haiping.steps.length) {
    lines.push('Steps to check:');
    haiping.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  }
  lines.push(
    haiping.notVisuallyVerified.length
      ? `Not visually verified: ${haiping.notVisuallyVerified.join(', ')}`
      : 'The handoff lists no visual gaps.',
  );
  return lines.join('\n');
}

function idempotencyKeyFor(kind: string, ticket: string, headSha: string): string {
  return createHash('sha256').update(JSON.stringify([kind, ticket, headSha])).digest('hex').slice(0, 16);
}

export function planJiraWrite(kind: string, ticket: string, headSha: string): ExternalWrite {
  return {
    id: `${kind}-${ticket}-${headSha}`,
    kind,
    idempotencyKey: idempotencyKeyFor(kind, ticket, headSha),
    state: 'intent',
    at: Date.now(),
  };
}

export interface JiraHandoffEvent {
  event: 'external.intent' | 'external.call' | 'external.complete' | 'external.unknown';
  kind: string;
  idempotencyKey: string;
  ticket: string;
  status?: number;
  body?: string;
}

export interface JiraHandoffEnv {
  qaAccountId?: string;
  qaTransitionId?: string;
}

async function performOne(
  kind: string,
  ticket: string,
  headSha: string,
  call: () => Promise<JiraCallResult>,
  emit: (event: JiraHandoffEvent) => void,
): Promise<{ line: string }> {
  const write = planJiraWrite(kind, ticket, headSha);
  emit({ event: 'external.intent', kind: write.kind, idempotencyKey: write.idempotencyKey, ticket });
  emit({ event: 'external.call', kind: write.kind, idempotencyKey: write.idempotencyKey, ticket });

  let result: JiraCallResult;
  try {
    result = await call();
  } catch (error) {
    result = { ok: false, body: error instanceof Error ? error.message : String(error) };
  }

  if (result.ok) {
    emit({ event: 'external.complete', kind: write.kind, idempotencyKey: write.idempotencyKey, ticket });
    return { line: `jira ${kind}: complete` };
  }
  emit({
    event: 'external.unknown', kind: write.kind, idempotencyKey: write.idempotencyKey, ticket,
    status: result.status, body: result.body?.slice(0, 300),
  });
  return { line: `jira ${kind}: unknown (${result.status ?? 'no status'}) ${result.body ?? ''}`.trim() };
}

/**
 * Runs the comment, then the assignment (when `env.qaAccountId` is set), then the
 * transition (when `env.qaTransitionId` is set), always in that order, always three
 * independent `ExternalWrite` cycles. A failure in one never stops the next -- the
 * comment failing must never suppress the assignment or the transition, since neither
 * one depends on the comment landing.
 */
export async function runJiraHandoff(
  client: JiraWriteClient,
  haiping: HaipingHandoff,
  headSha: string,
  prUrl: string,
  env: JiraHandoffEnv,
  emit: (event: JiraHandoffEvent) => void,
): Promise<string[]> {
  const ticket = haiping.ticket;
  const lines: string[] = [];

  const comment = await performOne(
    'jira-comment', ticket, headSha, () => client.comment(ticket, buildHandoffComment(haiping, prUrl)), emit,
  );
  lines.push(comment.line);

  if (env.qaAccountId) {
    const assign = await performOne(
      'jira-assign', ticket, headSha, () => client.assign(ticket, env.qaAccountId!), emit,
    );
    lines.push(assign.line);
  }

  if (env.qaTransitionId) {
    const transition = await performOne(
      'jira-transition', ticket, headSha, () => client.transition(ticket, env.qaTransitionId!), emit,
    );
    lines.push(transition.line);
  }

  return lines;
}
