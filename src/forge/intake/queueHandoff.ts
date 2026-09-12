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
   *  see". It includes deletions and renames, which is why the heading below says
   *  "adds, changes or removes" rather than promising each file still exists. */
  changedFiles?: string[];
}

/**
 * A file that renders something. Extension-gated on purpose (code review, 2026-09-12):
 * matching any path under `features/` swept in slices, barrels, types, tests and
 * snapshots, and a list padded with those trains a reader to skim past it.
 */
const VIEW_FILE = /\.(tsx|jsx)$/i;
/** Tests and snapshots render nothing a person opens. */
const NOT_A_VIEW = /\.(test|spec|stories)\.(tsx|jsx)$|\.snap$|(^|\/)(__tests__|__mocks__|test-utils)\//i;
/** A file every screen renders under, so a change here is not one screen's problem.
 *  Anchored to the repository root (code review, 2026-09-12): matching a bare
 *  `Navigation.tsx` or any directory named `navigation` anywhere claimed "this
 *  reaches every screen" for one feature's own nav file, which is the same kind of
 *  false claim this file exists to remove. */
const APP_ROOT_PATH = /^(src\/)?(app\/)?(App|AppRoot|RootNavigator|RootStack)\.(tsx|jsx)$|^(src\/)?navigation\/[^/]+\.(tsx|jsx)$/i;
/** At most this many names before the list stops being read. The comment is checked
 *  against a prose-word ceiling that DENIES, and a denied comment posts nothing at
 *  all -- so the biggest diffs, which most need the warning, got silence. */
const MAX_NAMED = 8;

/** Folder names that tell two files apart from nothing. */
const GENERIC_DIR = /^(components?|screens?|views?|containers?|ui|src|app)$/i;

/** Names in the diff that render something, deduped by full path rather than by
 *  basename: two `Header.tsx` under different features are two files, and collapsing
 *  them told a reader one screen changed when two did. */
function viewNamesIn(files: readonly string[]): string[] {
  const seen = new Set<string>();
  const taken = new Set<string>();
  const names: string[] = [];
  for (const file of files) {
    const path = file.split('\\').join('/');
    if (!VIEW_FILE.test(path) || NOT_A_VIEW.test(path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    const parts = path.split('/');
    const base = parts.pop()!.replace(/\.(tsx|jsx)$/i, '');
    // Skip the generic folder names -- `components/Header` and `screens/Header` read
    // as one file when they are two. Then widen back out until the rendered name is
    // unique: stripping a generic segment could collapse two paths the full path had
    // told apart, and the list then printed the same name twice (code review,
    // 2026-09-12).
    const meaningful = [...parts];
    while (meaningful.length && GENERIC_DIR.test(meaningful[meaningful.length - 1]!)) meaningful.pop();
    let rendered = meaningful.length ? `${meaningful[meaningful.length - 1]}/${base}` : base;
    let depth = 1;
    while (taken.has(rendered) && depth < parts.length) {
      depth += 1;
      rendered = `${parts.slice(-depth).join('/')}/${base}`;
    }
    taken.add(rendered);
    // Backticked: the readability contract counts prose words and scans them for
    // banned words, so a path segment could deny the whole comment and post nothing
    // at all. Code in backticks is exempt from both (code review, 2026-09-12).
    names.push(`\`${rendered}\``);
  }
  return names;
}

/**
 * Item 13, 2026-09-12. The comment posted at 16:01 on 2026-09-11 said "No visual check
 * needed here -- this one is covered by the suite." Nobody had looked at a screen, and
 * the change installed a touch handler at the app root, so every screen was affected.
 * The text is generated, so it kept saying it.
 *
 * The rule this file now holds: **no sentence makes a claim about the rendered result.**
 * A file list can say what is IN a diff. It can never say that what is missing from the
 * list does not render -- a colour token or a navigator changes every screen and looks
 * like neither. So the comment names what it found, says nobody looked, and asserts
 * nothing about the rest. Rewritten after a review found the first version saying "there
 * is nothing on screen to compare", which is the same unearned claim in new words.
 */
export function buildQueueHandoffComment(input: QueueHandoffInput): string {
  const lines: string[] = [`Opened ${input.prUrl}.`, input.what];
  if (input.testPlan.length) {
    lines.push('Quick visual check:');
    input.testPlan.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  }

  const files = input.changedFiles ?? [];
  if (files.some((file) => APP_ROOT_PATH.test(file.split('\\').join('/')))) {
    lines.push('This touches the app root, so it reaches every screen.');
  }
  const names = viewNamesIn(files);
  if (names.length) {
    const shown = names.slice(0, MAX_NAMED).join(', ');
    const rest = names.length - MAX_NAMED;
    // "adds, changes or removes", never "files that render": the list comes from the
    // pull request's own file list, which includes deletions, and pointing somebody at
    // a screen that no longer exists wastes the look (code review, 2026-09-12).
    lines.push(`Screens this diff adds, changes or removes: ${shown}${rest > 0 ? `, and ${rest} more` : ''}.`);
  }
  // The one sentence. It says what is NOT known, and claims nothing that is.
  // A first draft said "the tests pass and the types are clean", which nothing in this
  // input carries: an item whose worker was parked reaches this handoff anyway, and a
  // repo whose only green check is a build would have had the same sentence written
  // about it (code review, 2026-09-12). Removing an unearned claim and adding one a
  // line below it is the same defect twice.
  // The clause about the list is only true when a list was printed (code review,
  // 2026-09-12). Most of what the queue ships is backend or plain TypeScript, which
  // names nothing, and the sentence then pointed at a list that was never there.
  lines.push(names.length
    ? 'Nobody has looked at this on a screen, so the rendered result is unverified'
      + ' -- including anything the list above does not name.'
    : 'Nobody has looked at this on a screen, so the rendered result is unverified.');
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
