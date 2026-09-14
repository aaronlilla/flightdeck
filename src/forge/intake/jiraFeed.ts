/**
 * R-101: the Jira feed. The watcher (`watcherWire.ts`) turns a ticket assigned to the
 * operator into a queue item; this module handles everything else on the board that is
 * aimed at them: a comment that @-mentions them, a comment on a ticket they own or
 * reported, a comment or a new ticket's description that names them, and a comment that
 * only reads as aimed at them. Each one is resolved on its own:
 *
 *   - a lane already working the ticket gets the comment as a `/send`;
 *   - otherwise one bounded reasoner call decides: reply (posted when it passes the
 *     safety checks below), defer (raised as a question in the inbox, with the drafted
 *     reply offered as an option), or ignore (not aimed at the operator);
 *   - a deferred question answered in the console is posted as the reply.
 *
 * Every comment is claimed in the ledger BEFORE anything is written anywhere, so a crash
 * mid-resolution can lose a reply but can never post one twice. The feed skips every
 * comment the operator's own account wrote, which is also every reply it posts itself.
 *
 * Nothing here reads the environment or touches the network directly: the fetch, the
 * post, the reasoner, the inbox and the ledger are all injected, the same seams
 * `jira.ts`, `inbox.ts` and `reasoner-claude.ts` already define.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { QueueItem } from '../../shared/console-model.js';
import type { Reasoner } from '../contracts.js';
import type { Ask, InboxEntry } from '../inbox.js';
import { redact } from '../redact.js';
import type { JiraCallResult, JiraConfig } from './jira.js';
import { voiceGuard } from './voiceGuard.js';

/** The run name every feed question is raised under, so the feed can find its own
 *  answered questions again and nothing else's. */
export const FEED_RUN = 'jira-feed';

/** The option that closes a deferred question without posting anything. */
export const LEAVE_OPTION = 'Leave it for now';

/** The widest look-back a poll ever asks Jira for, however long the feed was down. */
const MAX_WINDOW_MINUTES = 24 * 60;
/** The narrowest: a poll every few seconds still re-reads a couple of minutes, because
 *  Jira's search index can lag a fresh comment by a few seconds. */
const MIN_WINDOW_MINUTES = 2;
/** A reply longer than this is not a quick answer and goes to a person instead. */
const MAX_REPLY_CHARS = 700;
/** Ledger entries older than this are dropped on write. */
const LEDGER_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const SEND_STATES = new Set(['running', 'parked', 'review']);

export interface FeedComment {
  /** Jira's comment id, or `desc:<KEY>` for a new ticket's own description. */
  id: string;
  authorAccountId: string;
  authorName: string;
  body: string;
  created: number;
  /** Account ids of every @-mention in the body. */
  mentions: string[];
}

export interface FeedIssue {
  key: string;
  summary: string;
  description: string;
  descriptionMentions: string[];
  status: string;
  assigneeAccountId: string | null;
  assigneeName: string | null;
  reporterAccountId: string | null;
  reporterName: string | null;
  created: number;
  updated: number;
  /** Oldest first. */
  comments: FeedComment[];
}

export interface FeedMe {
  accountId: string;
  /** Words a comment uses to name the operator, matched whole-word, case-insensitive. */
  names: string[];
}

// ---------------------------------------------------------------------------------------
// Reading Jira

interface AdfNode { type?: string; text?: string; attrs?: { id?: unknown; text?: unknown }; content?: unknown[] }

/** Account ids of every `mention` node in an Atlassian Document Format body. */
export function adfMentions(node: unknown): string[] {
  if (node == null || typeof node !== 'object') return [];
  const doc = node as AdfNode;
  const found: string[] = [];
  if (doc.type === 'mention' && typeof doc.attrs?.id === 'string') found.push(doc.attrs.id);
  for (const child of Array.isArray(doc.content) ? doc.content : []) found.push(...adfMentions(child));
  return found;
}

/** `jira.ts#flattenAdf`, except a mention keeps its visible text (`@Name`): the reasoner
 *  has to see who a comment is talking to, and `flattenAdf` drops mention nodes. */
export function feedText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return '';
  const doc = node as AdfNode;
  if (doc.type === 'text') return doc.text ?? '';
  if (doc.type === 'mention') return typeof doc.attrs?.text === 'string' ? doc.attrs.text : '@someone';
  const children = Array.isArray(doc.content) ? doc.content.map(feedText).filter((text) => text.length > 0) : [];
  if (doc.type === 'doc') return children.join('\n\n');
  return children.join('');
}

/** Every ticket in `project` touched in the last `sinceMinutes`. Relative minutes rather
 *  than a timestamp, so the site's own timezone never shifts the window. */
export function feedJql(project: string, sinceMinutes: number): string {
  return `project = ${project} AND updated >= -${sinceMinutes}m ORDER BY updated ASC`;
}

function basicAuth(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

interface JiraUser { accountId?: string; displayName?: string }
interface JiraComment { id?: string; author?: JiraUser; body?: unknown; created?: string }
interface JiraCommentPage { comments?: JiraComment[]; total?: number }
interface FeedSearchIssue {
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    status?: { name?: string };
    assignee?: JiraUser | null;
    reporter?: JiraUser | null;
    created?: string;
    updated?: string;
    comment?: JiraCommentPage;
  };
}

function commentFor(raw: JiraComment): FeedComment {
  return {
    id: raw.id ?? '',
    authorAccountId: raw.author?.accountId ?? '',
    authorName: raw.author?.displayName ?? '',
    body: typeof raw.body === 'string' ? raw.body : feedText(raw.body),
    created: Date.parse(raw.created ?? '') || 0,
    mentions: adfMentions(raw.body),
  };
}

async function failure(response: Response): Promise<Error> {
  let body = '';
  try { body = await response.text(); } catch { /* the status alone still says something */ }
  return new Error(`Jira ${response.status}: ${redact(body.slice(0, 200))}`);
}

export async function fetchFeedIssues(
  config: Pick<JiraConfig, 'site' | 'email' | 'token' | 'fetchFn'>, jql: string,
): Promise<FeedIssue[]> {
  const fetchFn = config.fetchFn ?? fetch;
  const auth = basicAuth(config.email, config.token);
  const issues: FeedIssue[] = [];
  let nextPageToken: string | undefined;
  let isLast = false;

  while (!isLast) {
    const response = await fetchFn(`${config.site}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({
        jql,
        fields: ['summary', 'description', 'status', 'assignee', 'reporter', 'created', 'updated', 'comment'],
        maxResults: 50,
        ...(nextPageToken ? { nextPageToken } : {}),
      }),
    });
    if (!response.ok) throw await failure(response);
    const data = (await response.json()) as { issues?: FeedSearchIssue[]; nextPageToken?: string; isLast?: boolean };
    for (const issue of data.issues ?? []) {
      const f = issue.fields;
      let rawComments = f.comment?.comments ?? [];
      // Search can return a truncated comment list on a long thread; the newest comments
      // are the ones that matter, so read them from the issue's own endpoint.
      if ((f.comment?.total ?? 0) > rawComments.length) {
        const page = await fetchFn(
          `${config.site}/rest/api/3/issue/${issue.key}/comment?orderBy=-created&maxResults=50`,
          { headers: { authorization: auth } },
        );
        if (!page.ok) throw await failure(page);
        rawComments = [...(((await page.json()) as JiraCommentPage).comments ?? [])].reverse();
      }
      issues.push({
        key: issue.key,
        summary: f.summary ?? '',
        description: typeof f.description === 'string' ? f.description : feedText(f.description),
        descriptionMentions: adfMentions(f.description),
        status: f.status?.name ?? '',
        assigneeAccountId: f.assignee?.accountId ?? null,
        assigneeName: f.assignee?.displayName ?? null,
        reporterAccountId: f.reporter?.accountId ?? null,
        reporterName: f.reporter?.displayName ?? null,
        created: Date.parse(f.created ?? '') || 0,
        updated: Date.parse(f.updated ?? '') || 0,
        comments: rawComments.map(commentFor),
      });
    }
    isLast = data.isLast ?? true;
    nextPageToken = data.nextPageToken;
  }
  return issues;
}

// ---------------------------------------------------------------------------------------
// The ledger

export type FeedOutcomeKind = 'claimed' | 'replied' | 'deferred' | 'sent' | 'ignored' | 'failed';

export interface FeedOutcome {
  at: number;
  ticket: string;
  outcome: FeedOutcomeKind;
  reason?: string;
}

export interface FeedLedger {
  /** Nothing created before this is ever handled: turning the feed on is not a request
   *  to answer the board's whole history. */
  startedAt: number;
  lastPollAt: number | null;
  handled: Record<string, FeedOutcome>;
  /** Inbox keys whose answer has already been posted (or deliberately not posted). */
  answered: string[];
}

export interface FeedLedgerStore {
  read(): FeedLedger;
  write(ledger: FeedLedger): void;
}

function blankLedger(now: number): FeedLedger {
  return { startedAt: now, lastPollAt: null, handled: {}, answered: [] };
}

export function memoryFeedLedger(startedAt: number): FeedLedgerStore {
  let ledger = blankLedger(startedAt);
  return {
    read: () => structuredClone(ledger),
    write: (next) => { ledger = structuredClone(next); },
  };
}

export function fileFeedLedger(path: string, now: () => number = Date.now): FeedLedgerStore {
  return {
    read() {
      if (!existsSync(path)) return blankLedger(now());
      try {
        const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<FeedLedger>;
        return {
          startedAt: typeof data.startedAt === 'number' ? data.startedAt : now(),
          lastPollAt: typeof data.lastPollAt === 'number' ? data.lastPollAt : null,
          handled: data.handled ?? {},
          answered: Array.isArray(data.answered) ? data.answered : [],
        };
      } catch {
        // A corrupt ledger restarts from now rather than from zero, so it can never
        // re-answer the board's history.
        return blankLedger(now());
      }
    },
    write(ledger) {
      const cutoff = now() - LEDGER_KEEP_MS;
      const handled = Object.fromEntries(Object.entries(ledger.handled).filter(([, row]) => row.at >= cutoff));
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...ledger, handled, answered: ledger.answered.slice(-500) }), 'utf8');
      renameSync(tmp, path);
    },
  };
}

// ---------------------------------------------------------------------------------------
// Deciding

export type FeedRelevance = 'self' | 'mention' | 'my-ticket' | 'named' | 'maybe';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function namesOperator(text: string, names: readonly string[]): boolean {
  return names.some((name) => name.trim().length > 0
    && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(name.trim())}($|[^\\p{L}\\p{N}])`, 'iu').test(text));
}

/** Why a comment might concern the operator, strongest reason first. `maybe` means no
 *  rule matched and only the reasoner can tell. */
export function classifyComment(issue: FeedIssue, comment: FeedComment, me: FeedMe): FeedRelevance {
  if (comment.authorAccountId === me.accountId) return 'self';
  if (comment.mentions.includes(me.accountId)) return 'mention';
  if (issue.assigneeAccountId === me.accountId || issue.reporterAccountId === me.accountId) return 'my-ticket';
  if (namesOperator(comment.body, me.names)) return 'named';
  return 'maybe';
}

export interface FeedDecision {
  action: 'reply' | 'defer' | 'ignore';
  directed: boolean;
  why: string;
  reply: string;
}

const RELEVANCE_WORDS: Record<Exclude<FeedRelevance, 'self'>, string> = {
  mention: 'it @-mentions you',
  'my-ticket': 'it is on a ticket you are assigned to or reported',
  named: 'it uses your name',
  maybe: 'nothing marks it as yours; decide whether it is aimed at you at all',
};

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function feedPrompt(
  issue: FeedIssue, comment: FeedComment, relevance: Exclude<FeedRelevance, 'self'>, operatorName: string,
): string {
  const thread = issue.comments
    .filter((row) => row.id !== comment.id && row.created <= comment.created)
    .slice(-8)
    .map((row) => `- ${row.authorName || 'someone'}: ${clip(row.body, 600)}`);
  return [
    `You are ${operatorName}, a developer on this team, reading a new Jira comment.`,
    `Why it reached you: ${RELEVANCE_WORDS[relevance]}.`,
    '',
    `Ticket ${issue.key}: ${issue.summary}`,
    `Status: ${issue.status || 'unknown'}. Assignee: ${issue.assigneeName ?? 'nobody'}. Reporter: ${issue.reporterName ?? 'unknown'}.`,
    `Description: ${clip(issue.description, 2000) || '(none)'}`,
    thread.length ? `Earlier comments:\n${thread.join('\n')}` : 'No earlier comments.',
    '',
    `The new comment, from ${comment.authorName || 'someone'}:`,
    clip(comment.body, 2000),
    '',
    'Decide one action:',
    '- reply: the comment asks you something (or needs an acknowledgement) and the ticket',
    '  text above fully answers it. Posting is safe only when the reply commits to no date,',
    '  scope, money, priority or decision nobody has already made on the ticket, and',
    '  guesses nothing about code you cannot see.',
    '- defer: it is aimed at you but needs a decision, a look at code, or a fact not on',
    '  the ticket. Draft the best reply you can anyway, for a person to approve.',
    '- ignore: it is not aimed at you, or needs nothing from you.',
    '',
    'A reply reads as the developer typing to a teammate: first person, casual, short (one',
    'to three sentences), plain words, no greeting, no sign-off, no headings or bullets, no',
    'mention of being automated, and never refers to the developer by name.',
    '',
    'Put exactly this in the "text" field, one field per line, REPLY last:',
    'ACTION: reply | defer | ignore',
    'DIRECTED: yes | no',
    'WHY: <one sentence>',
    'REPLY: <the reply, or empty for ignore>',
  ].join('\n');
}

/** Reads the four-line decision out of the reasoner's text. Also accepts the same
 *  fields as a JSON object, which is what a model that ignored the `text` wrapper sends.
 *  Anything unreadable is `null`, and the caller treats that as "ask a person". */
export function parseDecision(text: string): FeedDecision | null {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && typeof parsed['action'] === 'string') {
      const action = String(parsed['action']).toLowerCase();
      if (action !== 'reply' && action !== 'defer' && action !== 'ignore') return null;
      const directed = parsed['directed'];
      return {
        action,
        directed: directed === true || String(directed).toLowerCase() === 'yes',
        why: String(parsed['why'] ?? ''),
        reply: String(parsed['reply'] ?? '').trim(),
      };
    }
  } catch {
    // Not JSON: the line form below.
  }
  const action = /^\s*ACTION:\s*(reply|defer|ignore)\b/im.exec(trimmed)?.[1]?.toLowerCase();
  if (!action) return null;
  const directed = /^\s*DIRECTED:\s*(yes|no)\b/im.exec(trimmed)?.[1]?.toLowerCase() === 'yes';
  const why = /^\s*WHY:\s*(.*)$/im.exec(trimmed)?.[1]?.trim() ?? '';
  const replyMatch = /^\s*REPLY:[ \t]*([\s\S]*)$/im.exec(trimmed);
  return { action: action as FeedDecision['action'], directed, why, reply: replyMatch?.[1]?.trim() ?? '' };
}

/** The checks a reply passes before the feed posts it with nobody looking. A refusal
 *  names why, and the comment becomes a question instead. */
export function replyRefusal(reply: string, operatorNames: readonly string[]): string | null {
  if (reply.length === 0) return 'the drafted reply is empty';
  if (reply.length > MAX_REPLY_CHARS) return `the drafted reply is ${reply.length} characters, over ${MAX_REPLY_CHARS}`;
  const voice = voiceGuard(reply);
  if (!voice.ok) return voice.reason ?? 'the reply failed the voice check';
  if (namesOperator(reply, operatorNames)) return 'the reply names the operator in the third person';
  if (/\b(as an ai|language model|automated|bot)\b/i.test(reply)) return 'the reply describes itself as automated';
  return null;
}

// ---------------------------------------------------------------------------------------
// Resolving

export interface FeedActivityDeps {
  project: string;
  me: () => Promise<FeedMe | null>;
  /** The operator's display name, as the reasoner is told to write. */
  operatorName: () => string;
  fetchIssues: (jql: string) => Promise<FeedIssue[]>;
  ledger: FeedLedgerStore;
  reasoner: Pick<Reasoner, 'call'>;
  post: (ticket: string, body: string) => Promise<JiraCallResult>;
  raise: (ask: Ask) => InboxEntry;
  /** Every inbox entry; the feed filters to its own answered ones. */
  inboxEntries: () => InboxEntry[];
  queueItems: () => QueueItem[];
  sendTo: (runKey: string, text: string) => void;
  journal: { append(row: Record<string, unknown>): void };
  now?: () => number;
}

export interface FeedActivityResult {
  considered: number;
  replied: string[];
  deferred: string[];
  sent: string[];
  ignored: string[];
  failed: string[];
  answered: string[];
}

interface Candidate { issue: FeedIssue; comment: FeedComment; relevance: Exclude<FeedRelevance, 'self'> }

/** The description of a ticket created since the feed started, as a comment, when it
 *  mentions or names the operator on a ticket not already theirs. A ticket assigned to
 *  the operator is the watcher's to queue, not this module's to answer. */
function descriptionCandidate(issue: FeedIssue, me: FeedMe): FeedComment | null {
  if (issue.assigneeAccountId === me.accountId) return null;
  if (issue.reporterAccountId === me.accountId) return null;
  if (!issue.descriptionMentions.includes(me.accountId) && !namesOperator(issue.description, me.names)) return null;
  return {
    id: `desc:${issue.key}`,
    authorAccountId: issue.reporterAccountId ?? '',
    authorName: issue.reporterName ?? '',
    body: `${issue.summary}\n\n${issue.description}`,
    created: issue.created,
    mentions: issue.descriptionMentions,
  };
}

export async function runFeedActivity(deps: FeedActivityDeps): Promise<FeedActivityResult> {
  const now = deps.now ?? Date.now;
  const result: FeedActivityResult = {
    considered: 0, replied: [], deferred: [], sent: [], ignored: [], failed: [], answered: [],
  };
  const me = await deps.me();
  if (!me) throw new Error('could not read the Jira account behind the token');

  const ledger = deps.ledger.read();
  const pollAt = now();
  const since = Math.min(MAX_WINDOW_MINUTES, Math.max(
    MIN_WINDOW_MINUTES,
    Math.ceil((pollAt - (ledger.lastPollAt ?? pollAt)) / 60_000) + MIN_WINDOW_MINUTES,
  ));
  const issues = await deps.fetchIssues(feedJql(deps.project, since));

  const candidates: Candidate[] = [];
  for (const issue of issues) {
    const description = issue.created >= ledger.startedAt ? descriptionCandidate(issue, me) : null;
    const comments = description ? [description, ...issue.comments] : issue.comments;
    for (const comment of comments) {
      if (!comment.id || comment.created < ledger.startedAt || ledger.handled[comment.id]) continue;
      const relevance = comment.id.startsWith('desc:') ? 'named' as const : classifyComment(issue, comment, me);
      if (relevance === 'self') {
        ledger.handled[comment.id] = { at: pollAt, ticket: issue.key, outcome: 'ignored', reason: 'written by the operator' };
        continue;
      }
      ledger.handled[comment.id] = { at: pollAt, ticket: issue.key, outcome: 'claimed' };
      candidates.push({ issue, comment, relevance });
    }
  }
  // Claimed before any write: a crash from here on loses a reply rather than doubling one.
  ledger.lastPollAt = pollAt;
  deps.ledger.write(ledger);

  const record = (candidate: Candidate, outcome: FeedOutcomeKind, reason: string, list: string[]): void => {
    ledger.handled[candidate.comment.id] = { at: now(), ticket: candidate.issue.key, outcome, reason };
    list.push(candidate.issue.key);
    deps.ledger.write(ledger);
    deps.journal.append({
      event: `feed.${outcome}`, actor: 'feed', ticket: candidate.issue.key,
      comment: candidate.comment.id, relevance: candidate.relevance, reason,
    });
  };

  for (const candidate of candidates) {
    result.considered += 1;
    const { issue, comment, relevance } = candidate;
    try {
      const lane = relevance === 'maybe'
        ? undefined
        : deps.queueItems().find((item) => item.ticket === issue.key && SEND_STATES.has(item.state) && item.runKey);
      if (lane?.runKey) {
        deps.sendTo(lane.runKey, `${comment.authorName || 'someone'} commented on ${issue.key}: ${comment.body}`);
        record(candidate, 'sent', `sent to the lane working ${issue.key}`, result.sent);
        continue;
      }

      let decision: FeedDecision | null = null;
      let decisionError = '';
      try {
        const reply = await deps.reasoner.call({
          className: 'triage', prompt: feedPrompt(issue, comment, relevance, deps.operatorName()),
        });
        decision = parseDecision(reply.text);
        if (!decision) decisionError = 'the reasoner answered in a shape the feed cannot read';
      } catch (error) {
        decisionError = error instanceof Error ? error.message : String(error);
      }

      if (!decision) {
        if (relevance === 'maybe') {
          record(candidate, 'ignored', `no decision on an unmarked comment: ${decisionError}`, result.ignored);
        } else {
          raiseQuestion(deps, candidate, '');
          record(candidate, 'deferred', `no decision: ${decisionError}`, result.deferred);
        }
        continue;
      }
      if (decision.action === 'ignore' || (relevance === 'maybe' && !decision.directed)) {
        record(candidate, 'ignored', decision.why || 'not aimed at the operator', result.ignored);
        continue;
      }
      if (decision.action === 'reply') {
        const refusal = replyRefusal(decision.reply, me.names);
        if (!refusal) {
          const posted = await deps.post(issue.key, decision.reply);
          if (posted.ok) {
            record(candidate, 'replied', decision.why || 'answered from the ticket', result.replied);
            continue;
          }
          raiseQuestion(deps, candidate, decision.reply);
          record(candidate, 'deferred', `the reply was refused by Jira: ${posted.body ?? posted.status ?? 'no detail'}`, result.deferred);
          continue;
        }
        raiseQuestion(deps, candidate, decision.reply);
        record(candidate, 'deferred', refusal, result.deferred);
        continue;
      }
      raiseQuestion(deps, candidate, decision.reply);
      record(candidate, 'deferred', decision.why || 'needs a person', result.deferred);
    } catch (error) {
      record(candidate, 'failed', error instanceof Error ? error.message : String(error), result.failed);
    }
  }

  await postAnsweredQuestions(deps, ledger, result);
  return result;
}

function raiseQuestion(deps: FeedActivityDeps, candidate: Candidate, draft: string): void {
  const { issue, comment } = candidate;
  const question = `${comment.authorName || 'Someone'} on ${issue.key} (${clip(issue.summary, 80)}): "${clip(comment.body, 400)}"`;
  const options = draft ? [draft, LEAVE_OPTION] : [LEAVE_OPTION];
  deps.raise({
    run: FEED_RUN,
    actionTarget: `jira-comment:${comment.id}`,
    question,
    options,
    ...(draft ? { recommended: 0, optionSource: 'drafted' as const } : {}),
    kind: 'question',
    ticket: issue.key,
  });
}

/** A deferred question answered in the console is posted as the reply, once. The
 *  "leave it" option, and an empty answer, close it with nothing posted. */
async function postAnsweredQuestions(
  deps: FeedActivityDeps, ledger: FeedLedger, result: FeedActivityResult,
): Promise<void> {
  for (const entry of deps.inboxEntries()) {
    if (!entry.runs.includes(FEED_RUN) || entry.answer === undefined || !entry.ticket) continue;
    const token = `${entry.key}@${entry.answeredAt ?? 0}`;
    if (ledger.answered.includes(token)) continue;
    const answer = entry.answer.trim();
    ledger.answered.push(token);
    deps.ledger.write(ledger);
    if (!answer || answer === LEAVE_OPTION) {
      deps.journal.append({ event: 'feed.left', actor: 'feed', ticket: entry.ticket, key: entry.key });
      continue;
    }
    const posted = await deps.post(entry.ticket, answer);
    deps.journal.append({
      event: posted.ok ? 'feed.answer-posted' : 'feed.answer-failed', actor: 'feed', ticket: entry.ticket, key: entry.key,
      ...(posted.ok ? {} : { reason: posted.body ?? String(posted.status ?? '') }),
    });
    if (posted.ok) result.answered.push(entry.ticket);
    else result.failed.push(entry.ticket);
  }
}
