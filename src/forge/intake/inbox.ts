/**
 * `forge inbox`: which BBZ tickets actually need a human look, instead of a person
 * running a 1 MB JQL dump by hand and reading it themselves.
 *
 * `fetchInboxIssues` is the one network call, built on the same injected-`fetch` pattern
 * every other Jira function in this repository uses (`jira.ts`) so no specimen here ever
 * touches the network. `classifyInbox` is pure -- no fetch, no clock read except the `now`
 * it is handed -- so its three buckets are proven against fixtures, not against Jira.
 */
import { redact } from '../redact.js';

export interface InboxComment {
  authorAccountId: string;
  authorDisplayName: string;
  body: string;
  created: number;
}

export interface InboxIssue {
  key: string;
  summary: string;
  status: string;
  assigneeAccountId: string | null;
  assigneeDisplayName: string | null;
  reporterAccountId: string | null;
  updated: number;
  /** Newest last, matching Jira's own `comment` field order. */
  comments: InboxComment[];
}

export interface FetchInboxConfig {
  site: string;
  email: string;
  token: string;
  /** How far back `updated >= -{days}d` reaches. */
  days: number;
  fetchFn?: typeof fetch;
}

function basicAuth(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

interface JiraCommentBody { author?: { accountId?: string; displayName?: string }; body?: unknown; created?: string }
interface JiraSearchIssue {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string };
    assignee?: { accountId?: string; displayName?: string } | null;
    reporter?: { accountId?: string } | null;
    updated?: string;
    comment?: { comments?: JiraCommentBody[] };
  };
}
interface JiraSearchResponse { issues?: JiraSearchIssue[]; nextPageToken?: string; isLast?: boolean }

function flattenAdf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return '';
  const doc = node as { type?: string; text?: string; content?: unknown[] };
  if (doc.type === 'text') return doc.text ?? '';
  const children = Array.isArray(doc.content) ? doc.content.map(flattenAdf).filter((text) => text.length > 0) : [];
  if (doc.type === 'doc') return children.join('\n\n');
  return children.join('');
}

async function jiraErrorFor(response: Response): Promise<Error> {
  let body = '';
  try {
    body = await response.text();
  } catch {
    // A status alone is still worth reporting.
  }
  return new Error(`Jira ${response.status}: ${redact(body.slice(0, 200))}`);
}

/** Every open BBZ ticket updated in the last `days`, one page of up to 100 issues at a
 *  time, paged on `nextPageToken` until Jira reports the last page. */
export async function fetchInboxIssues(config: FetchInboxConfig): Promise<InboxIssue[]> {
  const fetchFn = config.fetchFn ?? fetch;
  const auth = basicAuth(config.email, config.token);
  const jql = `project = BBZ AND statusCategory != Done AND updated >= -${config.days}d ORDER BY updated DESC`;
  const issues: InboxIssue[] = [];
  let nextPageToken: string | undefined;
  let isLast = false;

  while (!isLast) {
    const response = await fetchFn(`${config.site}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({
        jql,
        fields: ['summary', 'status', 'assignee', 'reporter', 'updated', 'comment'],
        maxResults: 100,
        ...(nextPageToken ? { nextPageToken } : {}),
      }),
    });
    if (!response.ok) throw await jiraErrorFor(response);
    const data = (await response.json()) as JiraSearchResponse;
    for (const issue of data.issues ?? []) {
      issues.push({
        key: issue.key,
        summary: issue.fields.summary ?? '',
        status: issue.fields.status?.name ?? '',
        assigneeAccountId: issue.fields.assignee?.accountId ?? null,
        assigneeDisplayName: issue.fields.assignee?.displayName ?? null,
        reporterAccountId: issue.fields.reporter?.accountId ?? null,
        updated: Date.parse(issue.fields.updated ?? '') || 0,
        comments: (issue.fields.comment?.comments ?? []).map((comment) => ({
          authorAccountId: comment.author?.accountId ?? '',
          authorDisplayName: comment.author?.displayName ?? '',
          body: typeof comment.body === 'string' ? comment.body : flattenAdf(comment.body),
          created: Date.parse(comment.created ?? '') || 0,
        })),
      });
    }
    isLast = data.isLast ?? true;
    nextPageToken = data.nextPageToken;
  }

  return issues;
}

export interface InboxRow {
  key: string;
  status: string;
  assignee: string | null;
  lastCommenter: string | null;
  ageDays: number;
  summary: string;
}

export interface InboxBuckets {
  /** The last comment was not written by me, and it landed within the window: someone is
   *  waiting on a reply from me. */
  needsReply: InboxRow[];
  /** I wrote the last comment, and the ticket is now sitting with someone else. */
  awaitingOthers: InboxRow[];
  /** Assigned to me, a comment or the description in the window names a merged PR, but
   *  the status hasn't moved to In Review, QA, or Done -- the ticket's status is stale
   *  against work that already landed. Deliberately simple: any `PR #\d+` mention plus
   *  the word "merged" trips it, so it over-flags rather than silently missing one. */
  statusDrift: InboxRow[];
}

const MS_PER_DAY = 86_400_000;
const MERGED_PR_RE = /PR #\d+/i;
const IN_PROGRESS_STATUSES = new Set(['in review', 'qa', 'done']);

function rowFor(issue: InboxIssue, lastCommenter: string | null, now: number): InboxRow {
  return {
    key: issue.key,
    status: issue.status,
    assignee: issue.assigneeDisplayName,
    lastCommenter,
    ageDays: Math.floor((now - issue.updated) / MS_PER_DAY),
    summary: issue.summary,
  };
}

export function classifyInbox(
  issues: InboxIssue[], me: { accountId: string }, now: number,
): InboxBuckets {
  const buckets: InboxBuckets = { needsReply: [], awaitingOthers: [], statusDrift: [] };

  for (const issue of issues) {
    const lastComment = issue.comments.length ? issue.comments[issue.comments.length - 1]! : undefined;
    const isMine = issue.assigneeAccountId === me.accountId;

    if (lastComment && lastComment.authorAccountId !== me.accountId) {
      const ageMs = now - lastComment.created;
      if (ageMs <= 0 || ageMs / MS_PER_DAY <= 3650) {
        // Age windowing beyond "recent" is handled by the caller's own --days filter on
        // the JQL itself; here we only require the last comment to not be mine.
        buckets.needsReply.push(rowFor(issue, lastComment.authorDisplayName || null, now));
      }
    } else if (lastComment && lastComment.authorAccountId === me.accountId && !isMine) {
      buckets.awaitingOthers.push(rowFor(issue, lastComment.authorDisplayName || null, now));
    }

    if (isMine) {
      const status = issue.status.trim().toLowerCase();
      const mentionsMergedPr = issue.comments.some(
        (comment) => MERGED_PR_RE.test(comment.body) && /merged/i.test(comment.body),
      );
      if (mentionsMergedPr && !IN_PROGRESS_STATUSES.has(status)) {
        buckets.statusDrift.push(rowFor(
          issue, issue.comments.length ? issue.comments[issue.comments.length - 1]!.authorDisplayName || null : null, now,
        ));
      }
    }
  }

  return buckets;
}
