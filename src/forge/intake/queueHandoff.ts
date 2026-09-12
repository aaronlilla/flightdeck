/**
 * A.3: the Jira side of a queue item reaching `review` -- a comment in Aaron's own
 * voice (the PR link, what changed, a short visual test plan lifted from the brief),
 * an assignment to QA (`FORGE_JIRA_QA_ACCOUNT`), a transition
 * (`FORGE_JIRA_QA_TRANSITION`), and a remote issue link to the PR. The shape mirrors
 * `jiraHandoff.ts`'s own `runJiraHandoff` (the merge-time J3 handoff) exactly -- the
 * same `ExternalWrite` intent/call/complete-or-unknown cycle, one independent write per
 * kind, a failure in one never stopping the next -- because this is the same kind of
 * write at an earlier point in the same item's life, not a different contract.
 */
import { createHash } from 'node:crypto';

import type { ExternalWrite } from '../contracts.js';
import { voiceGuard } from './voiceGuard.js';
import { readabilityVerdict } from './readability.js';
import type { JiraCallResult, JiraWriteClient } from './jira.js';

export interface QueueHandoffInput {
  ticket: string;
  prUrl: string;
  /** One or two lines describing what changed -- lifted from the brief's own summary,
   *  never a second report format. */
  what: string;
  /** A short visual test plan, lifted from the brief's own Definition of Done. Empty is
   *  honest for a non-visual change; the comment says so plainly rather than inventing
   *  steps. */
  testPlan: string[];
  /** Item 13, 2026-09-12: the repo-relative paths this pull request changes, so the
   *  comment can name the screens rather than guess whether anyone needs to look.
   *  Absent means the caller does not know, which is never the same as "nothing to
   *  see". */
  changedFiles?: string[];
}

/** A path that puts something on a screen. Deliberately generous -- a false "look at
 *  this" costs a minute, and a missed one costs a defect reaching a person who was
 *  told not to look. */
const SCREEN_PATH = /(^|[/\\])(screens?|components?|features)[/\\]|(Screen|Card|Modal|Sheet|Header|Button)\.(tsx|jsx)$/i;

/** A file every screen renders under, so a change here is not one screen's problem. */
const APP_ROOT_PATH = /(^|[/\\])(App|AppRoot|RootNavigator|Navigation)\.(tsx|jsx)$|(^|[/\\])src[/\\]app[/\\].*\.(tsx|jsx)$/i;

function screenNamesIn(files: readonly string[]): string[] {
  const names = files
    .filter((file) => SCREEN_PATH.test(file) || APP_ROOT_PATH.test(file))
    .map((file) => file.split(/[/\\]/).pop()!.replace(/\.(tsx|jsx|ts|js)$/i, ''));
  return [...new Set(names)];
}

/**
 * Item 13, 2026-09-12. The comment posted at 16:01 on 2026-09-11 told QA "No visual
 * check needed here -- this one is covered by the suite." Nobody had looked at a
 * screen, and the change installed a touch handler at the app root, so every screen
 * was affected. The text is generated, so it kept saying it.
 *
 * The comment now states what was checked and by what, states plainly that no agent
 * looked at a screen, and lists the screens the diff touches. It never says a visual
 * check is unnecessary -- that is a claim only somebody who looked can make, and no
 * agent here has.
 */
export function buildQueueHandoffComment(input: QueueHandoffInput): string {
  const lines: string[] = [`Opened ${input.prUrl}.`, input.what];
  if (input.testPlan.length) {
    lines.push('Quick visual check:');
    input.testPlan.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  }

  const screens = input.changedFiles ? screenNamesIn(input.changedFiles) : null;
  const touchesRoot = (input.changedFiles ?? []).some((file) => APP_ROOT_PATH.test(file));

  if (screens !== null && screens.length === 0) {
    lines.push('The tests pass and the types are clean. No screen changes in this diff,'
      + ' so there is nothing on screen to compare.');
    return lines.join('\n');
  }

  if (touchesRoot) {
    lines.push('This touches the app root, so it reaches every screen, not only the ones below.');
  }
  if (screens?.length) {
    lines.push(`Screens in this diff: ${screens.join(', ')}.`);
  }
  lines.push('The tests pass and the types are clean, and nothing here was looked at on a screen'
    + ' by an agent -- so the rendered result is unverified either way.');
  return lines.join('\n');
}

export interface QueueHandoffEnv {
  qaAccountId?: string;
  qaTransitionId?: string;
}

export interface QueueHandoffEvent {
  event: 'external.intent' | 'external.call' | 'external.complete' | 'external.unknown' | 'voice.refused'
    | 'readability.refused';
  kind: string;
  idempotencyKey?: string;
  ticket: string;
  status?: number;
  body?: string;
  reason?: string;
}

function idempotencyKeyFor(kind: string, ticket: string, salt: string): string {
  return createHash('sha256').update(JSON.stringify([kind, ticket, salt])).digest('hex').slice(0, 16);
}

function planJiraWrite(kind: string, ticket: string, salt: string): ExternalWrite {
  return {
    id: `${kind}-${ticket}-${salt}`,
    kind,
    idempotencyKey: idempotencyKeyFor(kind, ticket, salt),
    state: 'intent',
    at: Date.now(),
  };
}

async function performOne(
  kind: string, ticket: string, salt: string, call: () => Promise<JiraCallResult>,
  emit: (event: QueueHandoffEvent) => void,
): Promise<{ line: string }> {
  const write = planJiraWrite(kind, ticket, salt);
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
 * Runs the comment (voice-guarded first -- requirement 4's own proven detector, never
 * skipped even though this module's own comment text is always generated in first
 * person), then the assignment (when `env.qaAccountId` is set), then the transition
 * (when `env.qaTransitionId` is set), then the remote issue link -- always in that
 * order, always independent `ExternalWrite` cycles. A failure in one never stops the
 * next.
 */
export async function runQueueHandoff(
  client: JiraWriteClient, input: QueueHandoffInput, env: QueueHandoffEnv,
  emit: (event: QueueHandoffEvent) => void,
): Promise<string[]> {
  const ticket = input.ticket;
  const lines: string[] = [];

  const commentText = buildQueueHandoffComment(input);
  const voice = voiceGuard(commentText);
  const asOf = new Date().toISOString().slice(0, 10);
  const readability = voice.ok
    ? readabilityVerdict('jira-comment', null, '', commentText, undefined, asOf)
    : null;
  if (!voice.ok) {
    emit({ event: 'voice.refused', kind: 'jira-comment', ticket, reason: voice.reason });
    lines.push(`jira-comment: refused by voiceGuard (${voice.reason})`);
  } else if (readability?.verdict === 'DENY') {
    emit({ event: 'readability.refused', kind: 'jira-comment', ticket, reason: readability.reason });
    lines.push(`jira-comment: refused by readability (${readability.reason})`);
  } else {
    const comment = await performOne('jira-comment', ticket, input.prUrl, () => client.comment(ticket, commentText), emit);
    lines.push(comment.line);
  }

  if (env.qaAccountId) {
    const assign = await performOne('jira-assign', ticket, input.prUrl, () => client.assign(ticket, env.qaAccountId!), emit);
    lines.push(assign.line);
  }

  if (env.qaTransitionId) {
    const transition = await performOne(
      'jira-transition', ticket, input.prUrl, () => client.transition(ticket, env.qaTransitionId!), emit,
    );
    lines.push(transition.line);
  }

  const link = await performOne('jira-link', ticket, input.prUrl, () => client.link(ticket, input.prUrl), emit);
  lines.push(link.line);

  return lines;
}
