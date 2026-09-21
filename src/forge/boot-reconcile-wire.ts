/**
 * The live wiring for `boot-reconcile.ts`: reads this machine's configuration and disk,
 * runs the four passes, and hands back lines for the boot log.
 *
 * Kept separate from the passes themselves so every rule above stays testable without a
 * checkout, a Jira tenant or a registry. This file only gathers; it decides nothing.
 */
import { existsSync } from 'node:fs';

import { bootReconcile, type BootReconcileResult, type CloneToCheck, type GitRun, type ReconcileRepo, type TicketComment, type TicketState } from './boot-reconcile.js';
import { baseFor, type ChainEnv } from './chain-env.js';
import { run as execRun } from './exec.js';
import type { Inbox } from './inbox.js';
import type { JiraConfig } from './intake/jira.js';
import type { QueueItem } from '../shared/console-model.js';

/** Every repository `FORGE_REPO_CHECKOUTS` names, with the base its runs are cut from.
 *  A configured checkout that is not on disk is skipped rather than reported: a machine
 *  legitimately carries entries for repositories it has not cloned. */
export function reposFromChainEnv(chainEnv: ChainEnv): ReconcileRepo[] {
  const repos: ReconcileRepo[] = [];
  for (const entry of chainEnv.checkouts) {
    if (!entry.value || !existsSync(entry.value)) continue;
    repos.push({ repo: entry.repo, checkout: entry.value, base: baseFor(chainEnv, entry.repo) });
  }
  return repos;
}

/** The run clones live queue items own. An item that never launched has no worktree and
 *  contributes nothing; a path that has been swept off disk is skipped rather than
 *  reported as a git failure. */
export function clonesFromQueue(items: QueueItem[]): CloneToCheck[] {
  const clones: CloneToCheck[] = [];
  for (const item of items) {
    if (!item.worktreePath || !item.base) continue;
    if (!existsSync(item.worktreePath)) continue;
    clones.push({ ticket: item.ticket ?? item.id, clonePath: item.worktreePath, base: item.base });
  }
  return clones;
}

/** `exec.ts`'s runner narrowed to the shape the passes ask for. Failures come back as
 *  `ok: false`, never as a throw, so one unreadable checkout cannot end the reconcile. */
export const realGit: GitRun = async (cwd, args) => {
  try {
    const result = await execRun({ argv: ['git', '-C', cwd, ...args], cwd, owner: 'boot-reconcile', cls: 'script' });
    return { ok: result.ok, out: result.tail ?? '' };
  } catch {
    return { ok: false, out: '' };
  }
};

interface JiraCommentAuthor { accountId?: string }
interface JiraCommentRow { author?: JiraCommentAuthor; created?: string }

/**
 * The operator's own account id, and every comment on the tickets that have an open ask.
 *
 * Returns `undefined` on any failure at all -- no credentials, a refused call, an
 * unparseable body. Pass 4 then retires nothing, which is the safe direction: a missing
 * read must never be mistaken for "nobody answered".
 */
export async function readJiraEvidence(
  config: JiraConfig | undefined, tickets: string[],
): Promise<{
  operatorAccountId: string;
  commentsByTicket: Map<string, TicketComment[]>;
  ticketStates: Map<string, TicketState>;
} | undefined> {
  if (!config || tickets.length === 0) return undefined;
  const fetchFn = config.fetchFn ?? fetch;
  const authorization = `Basic ${Buffer.from(`${config.email}:${config.token}`).toString('base64')}`;
  const headers = { authorization, accept: 'application/json' };
  let operatorAccountId: string;
  try {
    const me = await fetchFn(`${config.site}/rest/api/3/myself`, { headers });
    if (!me.ok) return undefined;
    const body = (await me.json()) as { accountId?: string };
    if (!body.accountId) return undefined;
    operatorAccountId = body.accountId;
  } catch {
    return undefined;
  }

  const commentsByTicket = new Map<string, TicketComment[]>();
  const ticketStates = new Map<string, TicketState>();
  for (const ticket of tickets) {
    try {
      const issue = await fetchFn(
        `${config.site}/rest/api/3/issue/${ticket}?fields=status,assignee`, { headers },
      );
      if (issue.ok) {
        const body = (await issue.json()) as {
          fields?: { assignee?: { accountId?: string } | null; status?: { statusCategory?: { key?: string } } };
        };
        ticketStates.set(ticket, {
          assigneeAccountId: body.fields?.assignee?.accountId ?? null,
          statusIsDone: body.fields?.status?.statusCategory?.key === 'done',
        });
      }
    } catch {
      // An unreadable ticket is simply absent from the map: pass 4 then falls through to
      // the comment evidence, and retires nothing if that is missing too.
    }
    try {
      const response = await fetchFn(
        `${config.site}/rest/api/3/issue/${ticket}/comment?maxResults=100&orderBy=created`, { headers },
      );
      // A ticket that cannot be read is simply absent from the map, which pass 4 reads as
      // "no evidence" rather than "no answer".
      if (!response.ok) continue;
      const body = (await response.json()) as { comments?: JiraCommentRow[] };
      commentsByTicket.set(ticket, (body.comments ?? []).flatMap((row) => {
        const accountId = row.author?.accountId;
        const created = row.created ? Date.parse(row.created) : Number.NaN;
        if (!accountId || !Number.isFinite(created)) return [];
        return [{ authorAccountId: accountId, createdMs: created }];
      }));
    } catch {
      continue;
    }
  }
  return { operatorAccountId, commentsByTicket, ticketStates };
}

export interface RunBootReconcileDeps {
  chainEnv: ChainEnv;
  queueItems: QueueItem[];
  inbox: Inbox;
  hasRegistryRow: (run: string) => boolean;
  jiraConfig: JiraConfig | undefined;
  now?: number;
}

/**
 * Gathers this machine's state and runs the reconcile.
 *
 * Called from `forge up` BEFORE the queue loop and the Jira watcher start: a run launched
 * from a stale checkout is the failure this exists to prevent, so reconciling after the
 * first tick would be reconciling behind the work.
 */
export async function runBootReconcile(deps: RunBootReconcileDeps): Promise<BootReconcileResult> {
  const liveQueueItemIds = new Set(deps.queueItems.map((item) => item.id));
  const ticketsWithOpenAsks = [...new Set(
    deps.inbox.open().map((entry) => entry.ticket).filter((t): t is string => Boolean(t)),
  )];
  const jira = await readJiraEvidence(deps.jiraConfig, ticketsWithOpenAsks);
  return bootReconcile({
    repos: reposFromChainEnv(deps.chainEnv),
    clones: clonesFromQueue(deps.queueItems),
    git: realGit,
    inbox: deps.inbox,
    hasRegistryRow: deps.hasRegistryRow,
    liveQueueItemIds,
    ...(jira ? { jira } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
}
