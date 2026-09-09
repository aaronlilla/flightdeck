/**
 * The real Jira REST v3 client behind `FakePollFeed` (J1), the probe that proves a
 * credential works before anything else trusts it (J4), and the write client the gate
 * uses to comment on, assign and transition a ticket once a merge lands (J3).
 *
 * `fetch` is injected everywhere in this file -- every function here takes it as a
 * parameter or accepts a config carrying one -- so no specimen in this repository ever
 * touches the network. Production leaves it unset and gets the global `fetch` Node
 * already provides.
 *
 * Nothing here reads `FORGE_JIRA_SITE`, `FORGE_JIRA_EMAIL` or `FORGE_JIRA_TOKEN` itself;
 * `cli.ts` reads the environment and passes the values in, which is what keeps a site,
 * an email or a token out of every tracked file in this repository (policy, brief
 * guardrails). Errors carry only the HTTP status and the first 200 characters of the
 * response body, redacted the same way `exec.ts` redacts a command's output -- a token
 * echoed back by a misconfigured proxy is exactly the shape that redaction already
 * catches.
 */
import { redact } from '../redact.js';
import type { PollSourceName } from '../contracts.js';
import type { FakePollFeed, PollItemDetail, RawPollItem } from './poller.js';

export interface JiraConfig {
  site: string;
  email: string;
  token: string;
  jql?: string;
  fetchFn?: typeof fetch;
  // R-11: the watcher polls the same Jira search as `chainIntake`'s feed, but through
  // its own watermark so the two never step on each other's progress. Defaults to
  // 'jira', the name every caller before this one relied on.
  sourceName?: PollSourceName;
}

export const DEFAULT_JIRA_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated ASC';

function basicAuth(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

async function jiraErrorFor(response: Response): Promise<Error> {
  let body = '';
  try {
    body = await response.text();
  } catch {
    // A response whose body can't be read still has a status worth reporting.
  }
  return new Error(`Jira ${response.status}: ${redact(body.slice(0, 200))}`);
}

/**
 * The Atlassian Document Format, flattened to the plain text the planner reads (J2).
 * Recurses on `content`; a `text` node is a leaf. Paragraph-level nodes join their
 * children with no separator (a paragraph's own text runs are one line); anything with
 * paragraph children (the document itself, a blockquote) joins with a blank line, the
 * same spacing Jira's own rendered view uses between paragraphs.
 */
export function flattenAdf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return '';
  const doc = node as { type?: string; text?: string; content?: unknown[] };
  if (doc.type === 'text') return doc.text ?? '';
  const children = Array.isArray(doc.content) ? doc.content.map(flattenAdf).filter((text) => text.length > 0) : [];
  if (doc.type === 'doc') return children.join('\n\n');
  return children.join('');
}

interface JiraSearchIssue {
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    status?: { name?: string; statusCategory?: { name?: string } };
    updated?: string;
    issuetype?: { name?: string };
    priority?: { name?: string };
    labels?: string[];
    components?: { name?: string }[];
    // R-11: the watcher's own read -- the newest comment on the issue, used to tell a
    // fresh instruction posted to an owned ticket from silence since the last poll.
    comment?: { comments?: { author?: { displayName?: string }; body?: unknown }[] };
  };
  renderedFields?: { description?: string };
}

interface JiraSearchResponse {
  issues?: JiraSearchIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}

/** R-11: the newest entry in `fields.comment.comments`. Jira returns them oldest
 *  first, so the last element is the one the watcher cares about. Resolves to
 *  `undefined` when the issue has no comments; `PollItemDetail.latestComment` uses
 *  that same `undefined` for "no comment yet" now that this always requests the field. */
function latestCommentFor(issue: JiraSearchIssue): { author: string; body: string } | undefined {
  const comments = issue.fields.comment?.comments ?? [];
  const last = comments[comments.length - 1];
  if (!last) return undefined;
  return { author: last.author?.displayName ?? '', body: flattenAdf(last.body) };
}

function detailFor(issue: JiraSearchIssue): PollItemDetail {
  const description = issue.renderedFields?.description ?? flattenAdf(issue.fields.description);
  const latestComment = latestCommentFor(issue);
  return {
    summary: issue.fields.summary ?? '',
    description,
    status: issue.fields.status?.name ?? '',
    issuetype: issue.fields.issuetype?.name ?? '',
    priority: issue.fields.priority?.name ?? '',
    // R1: what the repository router matches labels and components against.
    labels: issue.fields.labels ?? [],
    components: (issue.fields.components ?? []).map((c) => c.name ?? '').filter((name) => name.length > 0),
    // R-11: a Done status category closes the lane, a fresh comment on an owned
    // ticket becomes a `/send`.
    ...(issue.fields.status?.statusCategory?.name ? { statusCategory: issue.fields.status.statusCategory.name } : {}),
    ...(latestComment ? { latestComment } : {}),
  };
}

/**
 * J1: every issue the JQL matches, paged on `nextPageToken` until Jira reports the last
 * page. `fetchSince` ignores the watermark it is handed -- `poller.ts`'s own contract --
 * the JQL is the whole filter, and `runPoll` filters the result against the watermark
 * itself.
 */
export function createJiraFeed(config: JiraConfig): FakePollFeed {
  const fetchFn = config.fetchFn ?? fetch;
  const auth = basicAuth(config.email, config.token);

  return {
    name: config.sourceName ?? 'jira',
    async fetchSince(): Promise<RawPollItem[]> {
      const items: RawPollItem[] = [];
      let nextPageToken: string | undefined;
      let isLast = false;

      while (!isLast) {
        const response = await fetchFn(`${config.site}/rest/api/3/search/jql`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: auth },
          body: JSON.stringify({
            jql: config.jql ?? DEFAULT_JIRA_JQL,
            fields: [
              'summary', 'description', 'status', 'updated', 'issuetype', 'priority', 'labels', 'components',
              'comment',
            ],
            maxResults: 50,
            ...(nextPageToken ? { nextPageToken } : {}),
          }),
        });
        if (!response.ok) throw await jiraErrorFor(response);

        const data = (await response.json()) as JiraSearchResponse;
        for (const issue of data.issues ?? []) {
          items.push({
            id: issue.key,
            updated: Date.parse(issue.fields.updated ?? '') || 0,
            detail: detailFor(issue),
          });
        }
        isLast = data.isLast ?? true;
        nextPageToken = data.nextPageToken;
      }

      return items;
    },
  };
}

export interface JiraProbeResult {
  ok: boolean;
  displayName?: string;
  accountId?: string;
  status?: number;
}

/**
 * J4: the cheapest possible proof that a credential works, run the moment the token
 * exists. Prints nothing itself -- `cli.ts` owns the two output lines -- so this stays a
 * pure fetch-and-report function a specimen can call directly.
 */
export async function probeJira(
  config: Pick<JiraConfig, 'site' | 'email' | 'token' | 'fetchFn'>,
): Promise<JiraProbeResult> {
  const fetchFn = config.fetchFn ?? fetch;
  const response = await fetchFn(`${config.site}/rest/api/3/myself`, {
    headers: { authorization: basicAuth(config.email, config.token) },
  });
  if (!response.ok) return { ok: false, status: response.status };
  const data = (await response.json()) as { displayName?: string; accountId?: string };
  return { ok: true, displayName: data.displayName ?? '', accountId: data.accountId ?? '' };
}

export interface JiraCallResult {
  ok: boolean;
  status?: number;
  body?: string;
}

/** J3: the writes `forge gate --merge` (and, A.3, the queue's own `queueHandoff.ts`)
 *  make once a ticket clears. */
export interface JiraWriteClient {
  comment(key: string, body: string): Promise<JiraCallResult>;
  assign(key: string, accountId: string): Promise<JiraCallResult>;
  transition(key: string, transitionId: string): Promise<JiraCallResult>;
  /** A.3: `POST /rest/api/3/issue/{key}/remotelink` -- a remote issue link to the PR,
   *  so the ticket carries a first-class link to it rather than only a comment
   *  mentioning the URL. */
  link(key: string, url: string): Promise<JiraCallResult>;
}

async function callResultFor(response: Response): Promise<JiraCallResult> {
  if (response.ok) return { ok: true, status: response.status };
  let body = '';
  try {
    body = await response.text();
  } catch {
    // As above: a status alone still tells the caller something happened.
  }
  return { ok: false, status: response.status, body: redact(body.slice(0, 300)) };
}

interface AdfTextNode { type: 'text'; text: string }
interface AdfHardBreak { type: 'hardBreak' }
interface AdfParagraph { type: 'paragraph'; content: (AdfTextNode | AdfHardBreak)[] }
export interface AdfDocument { type: 'doc'; version: 1; content: AdfParagraph[] }

/**
 * R2: `POST /rest/api/3/issue/{key}/comment` requires an Atlassian Document Format body
 * (a plain string gets `400 {"errors":{"comment":"Comment body is not valid!"}}`). One
 * paragraph per blank-line-separated block, each line inside a block as a `text` node
 * joined by `hardBreak` nodes, no marks.
 */
export function adfFromText(text: string): AdfDocument {
  const blocks = text.split(/\n{2,}/).filter((block) => block.length > 0);
  const content: AdfParagraph[] = blocks.map((block) => {
    const lines = block.split('\n');
    const paragraphContent: (AdfTextNode | AdfHardBreak)[] = [];
    lines.forEach((line, index) => {
      if (index > 0) paragraphContent.push({ type: 'hardBreak' });
      paragraphContent.push({ type: 'text', text: line });
    });
    return { type: 'paragraph', content: paragraphContent };
  });
  return { type: 'doc', version: 1, content };
}

export function createJiraWriteClient(config: Pick<JiraConfig, 'site' | 'email' | 'token' | 'fetchFn'>): JiraWriteClient {
  const fetchFn = config.fetchFn ?? fetch;
  const auth = basicAuth(config.email, config.token);
  const headers = { 'content-type': 'application/json', authorization: auth };

  return {
    async comment(key, body) {
      const response = await fetchFn(`${config.site}/rest/api/3/issue/${key}/comment`, {
        method: 'POST', headers, body: JSON.stringify({ body: adfFromText(body) }),
      });
      return callResultFor(response);
    },
    async assign(key, accountId) {
      const response = await fetchFn(`${config.site}/rest/api/3/issue/${key}/assignee`, {
        method: 'PUT', headers, body: JSON.stringify({ accountId }),
      });
      return callResultFor(response);
    },
    async transition(key, transitionId) {
      const response = await fetchFn(`${config.site}/rest/api/3/issue/${key}/transitions`, {
        method: 'POST', headers, body: JSON.stringify({ transition: { id: transitionId } }),
      });
      return callResultFor(response);
    },
    async link(key, url) {
      const response = await fetchFn(`${config.site}/rest/api/3/issue/${key}/remotelink`, {
        method: 'POST', headers, body: JSON.stringify({ object: { url, title: url } }),
      });
      return callResultFor(response);
    },
  };
}
