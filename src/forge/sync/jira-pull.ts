/**
 * R-68 item 3: the sync program's `pull-jira` stage. One search over the watcher's own
 * clause-1 JQL (`watcherJql(project)`, no owned keys -- `assignee = currentUser()`),
 * skip whatever the `reconcile-prs` stage (stream B) already reported shipped, and for
 * everything left either reuse a brief this fleet already wrote or queue the ticket for
 * the planner.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { addTicketItem } from '../intake/queue.js';
import type { QueueStore } from '../intake/queueStore.js';
import type { FakePollFeed } from '../intake/poller.js';
import type { Journal } from '../journal.js';

export interface NewestBrief {
  path: string;
  ms: number;
}

/** The newest `jira_<KEY>_<ms>.md` in `dir` for `ticket`, or undefined when none exists.
 *  `list` is injected so a test never touches a real directory. */
export function findNewestBrief(
  dir: string, ticket: string, list: (d: string) => string[] = (d) => readdirSync(d),
): NewestBrief | undefined {
  const prefix = `jira_${ticket}_`;
  let newest: NewestBrief | undefined;
  let files: string[];
  try {
    files = list(dir);
  } catch {
    return undefined;
  }
  for (const name of files) {
    if (!name.startsWith(prefix) || !name.endsWith('.md')) continue;
    const ms = Number(name.slice(prefix.length, -'.md'.length));
    if (!Number.isFinite(ms)) continue;
    if (!newest || ms > newest.ms) newest = { path: join(dir, name), ms };
  }
  return newest;
}

export interface JiraPullDeps {
  /** `watcherFeed(project, config)` with no owned keys -- clause 1 alone. */
  feed: FakePollFeed;
  store: QueueStore;
  briefsDir: string;
  /** Ticket keys `reconcile-prs` (stream B) already reported merged this run. */
  shippedKeys: readonly string[];
  journal: Journal;
  now?: () => number;
  /** Test seam for `findNewestBrief`'s own directory listing. */
  listBriefs?: (dir: string) => string[];
}

export interface JiraPullResult {
  added: string[];
  reused: string[];
  planned: string[];
  skipped: string[];
}

export async function pullJira(deps: JiraPullDeps): Promise<JiraPullResult> {
  const now = deps.now ?? Date.now;
  const shipped = new Set(deps.shippedKeys);
  const items = await deps.feed.fetchSince({ source: 'jira', committedAt: 0, idsAtCommittedAt: [] });

  const added: string[] = [];
  const reused: string[] = [];
  const planned: string[] = [];
  const skipped: string[] = [];

  for (const raw of items) {
    const ticket = raw.id;
    if (shipped.has(ticket)) {
      skipped.push(ticket);
      continue;
    }
    const at = now();
    const item = addTicketItem(deps.store, ticket, at);
    added.push(ticket);

    const brief = findNewestBrief(deps.briefsDir, ticket, deps.listBriefs);
    if (brief && brief.ms >= raw.updated) {
      deps.store.append({ id: item.id, at, briefPath: brief.path, updatedAt: at });
      deps.journal.append({ event: 'sync.plan-reused', actor: 'sync', ticket, brief: brief.path } as never);
      reused.push(ticket);
    } else {
      planned.push(ticket);
    }
  }

  return { added, reused, planned, skipped };
}
