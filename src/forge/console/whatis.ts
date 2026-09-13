import type { Lane, QueueItem } from '../../shared/console-model.js';

/**
 * What an identifier on screen actually refers to.
 *
 * Aaron, 2026-09-12: "when i hover over an item that has an acronym, like a bbz ticket
 * number, i should be able to see full detail of the ticket or whatever it is, ticket or
 * not."
 *
 * The board is full of short references — `BBZ-169`, `PR #159`, a run's own name — and
 * every one of them is a thing the reader is expected to already know. Linking them out
 * to Jira or GitHub helps only if you are willing to leave the page. This answers the
 * same question in place.
 *
 * Resolution is deliberately layered, cheapest first: what the console already holds
 * answers instantly and is never wrong about its own state, and only a ticket nobody on
 * the board is working costs a call to Jira. A reference that resolves to nothing says
 * so, rather than showing an empty card.
 */

export type WhatIsKind = 'ticket' | 'pull-request' | 'run' | 'unknown';

/**
 * A title with its own key appended reads as a stutter on a card that already shows the
 * key in its corner: "Fix the drop-down (BBZ-169)" under a heading that says `BBZ-169`.
 * Trimmed only when the key matches the reference the card is about, and only when
 * something is left over -- a title that is nothing but its key keeps it.
 */
export function titleWithoutRef(title: string | null, ref: string): string | null {
  if (!title) return title;
  const trimmed = title.trim();
  // Written without a regex. A pattern built into a template literal loses its escapes --
  // `\s` becomes a bare `s` -- which is how the first version silently matched the letter
  // s instead of whitespace and left "Fix the drop-down BBZ-169" untouched (2026-09-12).
  const endings = [`(${ref})`, `[${ref}]`, ref];
  for (const ending of endings) {
    if (!trimmed.toLowerCase().endsWith(ending.toLowerCase())) continue;
    const head = trimmed.slice(0, trimmed.length - ending.length);
    // Only when the key is a suffix hanging off real words, never when it IS the title.
    const cut = head.replace(/[\s–—-]+$/, '').trim();
    if (cut.length > 0) return cut;
  }
  return trimmed;
}


export interface WhatIsField {
  label: string;
  value: string;
}

export interface WhatIs {
  kind: WhatIsKind;
  /** The reference as it was asked about, e.g. `BBZ-169`. */
  ref: string;
  /** One line naming the thing: a ticket's summary, a pull request's title. */
  title: string | null;
  /** Where it stands, in the source's own words. */
  state: string | null;
  /** Everything else worth reading, in display order. */
  fields: WhatIsField[];
  /** Longer prose — a ticket's description, a run's own sentence. */
  body: string | null;
  /** Where to open it in full. */
  url: string | null;
}

/** A Jira-shaped key. The same shape `Linkify` already turns into a link. */
const TICKET_RE = /^[A-Z]{2,6}-\d+$/;
/** `#159`, `PR #159`, `pull request #159`. */
const PR_RE = /^(?:draft\s+)?(?:pull request|PR)?\s*#(\d+)$/i;

export function classifyRef(ref: string): WhatIsKind {
  const trimmed = ref.trim();
  if (TICKET_RE.test(trimmed)) return 'ticket';
  if (PR_RE.test(trimmed)) return 'pull-request';
  if (trimmed.length > 0) return 'run';
  return 'unknown';
}

export function prNumberFrom(ref: string): number | null {
  const match = PR_RE.exec(ref.trim());
  return match?.[1] ? Number(match[1]) : null;
}

/** What the board itself knows about a ticket: which lanes carry it and where they are. */
export function fromBoard(ref: string, lanes: readonly Lane[], queue: readonly QueueItem[]): WhatIs | null {
  const key = ref.trim();
  const lane = lanes.find((row) => row.ticket === key);
  const item = queue.find((row) => row.ticket === key);
  if (!lane && !item) return null;
  const fields: WhatIsField[] = [];
  if (lane) fields.push({ label: 'On the board', value: lane.state });
  if (item) fields.push({ label: 'In the queue', value: item.state });
  const pr = lane?.pr ?? item?.pr ?? null;
  if (pr) {
    fields.push({ label: 'Pull request', value: `#${pr.no}${pr.draft ? ' (draft)' : ''}${pr.merged ? ' · merged' : ''}` });
    if (pr.checks) fields.push({ label: 'Checks', value: pr.checks });
    if (pr.verdict) fields.push({ label: 'Council', value: pr.verdict });
  }
  if (item?.repo) fields.push({ label: 'Repository', value: item.repo });
  return {
    kind: 'ticket', ref: key,
    title: titleWithoutRef(lane?.title ?? item?.title ?? null, key),
    state: lane?.state ?? item?.state ?? null,
    fields,
    body: lane?.plain ?? null,
    url: lane?.sourceUrl ?? null,
  };
}

/** A pull request the board is already tracking. */
export function pullRequestFromBoard(no: number, lanes: readonly Lane[], queue: readonly QueueItem[]): WhatIs | null {
  const lane = lanes.find((row) => row.pr?.no === no);
  const item = queue.find((row) => row.pr?.no === no);
  const pr = lane?.pr ?? item?.pr ?? null;
  if (!pr) return null;
  const fields: WhatIsField[] = [];
  if (pr.draft) fields.push({ label: 'Draft', value: 'yes' });
  if (pr.merged) fields.push({ label: 'Merged', value: 'yes' });
  if (pr.checks) fields.push({ label: 'Checks', value: pr.checks });
  if (pr.verdict) fields.push({ label: 'Council', value: pr.verdict });
  if (pr.files !== undefined) fields.push({ label: 'Diff', value: `${pr.files} files, +${pr.add ?? 0} −${pr.del ?? 0}` });
  const ticket = lane?.ticket ?? item?.ticket ?? null;
  if (ticket) fields.push({ label: 'Ticket', value: ticket });
  return {
    kind: 'pull-request', ref: `#${no}`,
    title: pr.title ?? null,
    state: pr.merged ? 'merged' : pr.draft ? 'draft' : 'open',
    fields, body: null, url: pr.url ?? null,
  };
}

/** A run or lane, named by its own id. */
export function runFromBoard(ref: string, lanes: readonly Lane[]): WhatIs | null {
  const key = ref.trim();
  const lane = lanes.find((row) => row.id === key || row.title === key);
  if (!lane) return null;
  const fields: WhatIsField[] = [{ label: 'State', value: lane.state }];
  if (lane.ticket) fields.push({ label: 'Ticket', value: lane.ticket });
  if (lane.repo) fields.push({ label: 'Repository', value: lane.repo });
  if (lane.live) fields.push({ label: 'Process', value: lane.live.alive ? 'running' : 'not running' });
  if (lane.retiredAt) fields.push({ label: 'On the board', value: 'archived' });
  return {
    kind: 'run', ref: key,
    title: lane.title ?? lane.ticket ?? null,
    state: lane.state,
    fields, body: lane.plain ?? null,
    url: lane.sourceUrl ?? null,
  };
}

/** One Jira issue, as this route needs it. */
export interface JiraIssueFacts {
  summary: string | null;
  status: string | null;
  assignee: string | null;
  issueType: string | null;
  priority: string | null;
  updated: string | null;
  description: string | null;
}

/**
 * How long ago, in words. Jira answers `2026-09-11T16:24:51.519-0700`, which is a machine
 * stamp and reads as one on a card somebody is glancing at (Aaron, 2026-09-12: "the text
 * looks terrible"). Anything older than a week keeps its date, because "9 days ago" is
 * less useful than the day itself once it stops being recent.
 */
export function agoWords(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(at).toISOString().slice(0, 10);
}

/** A Jira issue turned into the same shape every other source answers in. */
export function fromJira(ref: string, issue: JiraIssueFacts, site: string | null, now = Date.now()): WhatIs {
  const fields: WhatIsField[] = [];
  if (issue.issueType) fields.push({ label: 'Type', value: issue.issueType });
  if (issue.assignee) fields.push({ label: 'Assignee', value: issue.assignee });
  if (issue.priority) fields.push({ label: 'Priority', value: issue.priority });
  if (issue.updated) fields.push({ label: 'Updated', value: agoWords(issue.updated, now) });
  return {
    kind: 'ticket', ref,
    title: titleWithoutRef(issue.summary, ref),
    state: issue.status,
    fields,
    body: issue.description,
    url: site ? `${site.replace(/\/+$/, '')}/browse/${ref}` : null,
  };
}

/** Nothing on the board or in Jira answers to this. Said rather than shown as blank. */
export function notFound(ref: string): WhatIs {
  return {
    kind: 'unknown', ref, title: null, state: null,
    fields: [], body: `Nothing on the board or in Jira answers to ${ref}.`, url: null,
  };
}

/**
 * Merges what the board knows into what Jira said.
 *
 * Jira is the authority on the ticket; the board is the authority on what is being done
 * about it here. A reader hovering `BBZ-169` wants both, and neither source knows the
 * other's half.
 */
export function mergeTicket(jira: WhatIs, board: WhatIs | null): WhatIs {
  if (!board) return jira;
  const seen = new Set(jira.fields.map((field) => field.label));
  return {
    ...jira,
    title: jira.title ?? board.title,
    fields: [...jira.fields, ...board.fields.filter((field) => !seen.has(field.label))],
    body: jira.body ?? board.body,
  };
}
