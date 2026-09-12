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
import type { FakePollFeed, PollItemDetail, RawPollItem } from './poller.js';
import { readabilityVerdict } from './readability.js';

export interface JiraConfig {
  site: string;
  email: string;
  token: string;
  jql?: string;
  fetchFn?: typeof fetch;
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
    status?: { name?: string };
    updated?: string;
    issuetype?: { name?: string };
    priority?: { name?: string };
    labels?: string[];
    components?: { name?: string }[];
  };
  renderedFields?: { description?: string };
}

interface JiraSearchResponse {
  issues?: JiraSearchIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}

function detailFor(issue: JiraSearchIssue): PollItemDetail {
  const description = issue.renderedFields?.description ?? flattenAdf(issue.fields.description);
  return {
    summary: issue.fields.summary ?? '',
    description,
    status: issue.fields.status?.name ?? '',
    issuetype: issue.fields.issuetype?.name ?? '',
    priority: issue.fields.priority?.name ?? '',
    // R1: what the repository router matches labels and components against.
    labels: issue.fields.labels ?? [],
    components: (issue.fields.components ?? []).map((c) => c.name ?? '').filter((name) => name.length > 0),
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
    name: 'jira',
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
            fields: ['summary', 'description', 'status', 'updated', 'issuetype', 'priority', 'labels', 'components'],
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
      // The backstop: whatever assembled `body` and whichever caller reached this
      // point, a DENY refuses the write here too, before `fetchFn` is ever called.
      // Callers with journal access (queueHandoff.ts) check first and emit their own
      // refusal event; this exists for the caller that forgets to.
      const asOf = new Date().toISOString().slice(0, 10);
      const verdict = readabilityVerdict('jira-comment', null, '', body, undefined, asOf);
      if (verdict.verdict === 'DENY') {
        return { ok: false, body: `readability refused this comment: ${verdict.reason}` };
      }
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

/**
 * A ticket's own comment bodies, as plain text. Read before work starts on the ticket:
 * a pull request opened for it is visible here long before the status field moves (see
 * `inFlight.ts`). Atlassian Document Format bodies are flattened to text, because all
 * this caller wants out of them is a URL.
 */
/**
 * Every URL an Atlassian Document Format node carries in an attribute rather than in its
 * text.
 *
 * `flattenAdf` returns text from `text` nodes only. Jira Cloud renders a pasted GitHub URL
 * as an `inlineCard` (and the GitHub integration as a `blockCard`), which has an
 * `attrs.url` and no text at all; a link written over words carries its target in
 * `marks[].attrs.href` while its text reads "the PR". Both flatten to nothing, and a
 * caller hunting for a pull request URL in a comment finds none — which is the case the
 * in-flight check exists for (review, 2026-09-12).
 */
export function adfUrls(node: unknown): string[] {
  if (node == null || typeof node !== 'object') return [];
  const found: string[] = [];
  const doc = node as {
    attrs?: { url?: unknown };
    marks?: { attrs?: { href?: unknown } }[];
    content?: unknown[];
  };
  if (typeof doc.attrs?.url === 'string') found.push(doc.attrs.url);
  for (const mark of Array.isArray(doc.marks) ? doc.marks : []) {
    if (typeof mark?.attrs?.href === 'string') found.push(mark.attrs.href);
  }
  for (const child of Array.isArray(doc.content) ? doc.content : []) {
    found.push(...adfUrls(child));
  }
  return found;
}

export async function fetchIssueComments(
  config: Pick<JiraConfig, 'site' | 'email' | 'token' | 'fetchFn'>,
  key: string,
): Promise<string[]> {
  const fetchFn = config.fetchFn ?? fetch;
  const response = await fetchFn(`${config.site}/rest/api/3/issue/${key}/comment`, {
    headers: { authorization: basicAuth(config.email, config.token) },
  });
  if (!response.ok) throw await jiraErrorFor(response);
  const data = (await response.json()) as { comments?: { body?: unknown }[] };
  return (data.comments ?? []).map((comment) => {
    if (typeof comment.body === 'string') return comment.body;
    // The rendered text plus every URL the nodes carry in attributes. A smart link has no
    // text, so text alone loses exactly the comment this read exists to find.
    return [flattenAdf(comment.body), ...adfUrls(comment.body)].filter(Boolean).join('\n');
  });
}

/** A ticket's remote issue links, as URLs. The other place a pull request shows up on a
 *  ticket whose status has not moved. */
export async function fetchIssueRemoteLinks(
  config: Pick<JiraConfig, 'site' | 'email' | 'token' | 'fetchFn'>,
  key: string,
): Promise<string[]> {
  const fetchFn = config.fetchFn ?? fetch;
  const response = await fetchFn(`${config.site}/rest/api/3/issue/${key}/remotelink`, {
    headers: { authorization: basicAuth(config.email, config.token) },
  });
  if (!response.ok) throw await jiraErrorFor(response);
  const data = (await response.json()) as { object?: { url?: string } }[];
  return (Array.isArray(data) ? data : []).map((link) => link.object?.url ?? '').filter(Boolean);
}
