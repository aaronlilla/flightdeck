/**
 * Refuse to start a ticket whose work is already in flight.
 *
 * The symptom this exists for: a ticket read `Backlog`, unassigned, on the board while
 * carrying a draft pull request opened that morning -- visible only in its comments.
 * Nothing transitions a ticket when a pull request opens for it, so the status field
 * lies, and picking by status alone offers finished work.
 *
 * The fix therefore never reads the status field. It reads the ticket's own comments and
 * its remote links for a pull request URL, then asks GitHub what that pull request is
 * doing now:
 *
 *   OPEN    -- someone is working on it. Refuse, quoting the URL.
 *   MERGED  -- the work landed. Refuse, quoting the URL.
 *   CLOSED  -- abandoned without landing. Start, and say which pull request was closed.
 *   unknown -- the state could not be read. Refuse: an unmeasured pull request reads as
 *              in flight, never as absent (standing order 1).
 *
 * Only the named ticket's own comments are read. A key mentioned in a comment on a
 * different ticket is that ticket's business and never reaches this check.
 */

/** `https://github.com/<owner>/<name>/pull/<n>`, the only shape a pull request URL takes
 *  in a comment or a remote link. Global so one comment mentioning two of them yields
 *  two refs. */
const PR_URL = /https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/g;

export type MentionSource = 'comment' | 'remote-link';

export interface PullRequestRef {
  repo: string;
  pr: number;
  url: string;
  where: MentionSource;
}

export interface MentionText {
  where: MentionSource;
  text: string;
}

/** Every pull request URL in the given texts, in order, deduplicated by repo and number
 *  so the same pull request quoted in three comments is one ref. */
export function findPullRequestRefs(sources: MentionText[]): PullRequestRef[] {
  const found: PullRequestRef[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    PR_URL.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PR_URL.exec(source.text))) {
      const repo = `${match[1]}/${match[2]}`;
      const pr = Number(match[3]);
      const key = `${repo.toLowerCase()}#${pr}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ repo, pr, url: match[0], where: source.where });
    }
  }
  return found;
}

export type PullRequestState = 'OPEN' | 'MERGED' | 'CLOSED';

/** The repository name alone, so `BOLTBETZ-LLC/v2-React-Native` and `v2-react-native`
 *  compare equal. The owner is dropped on purpose: a routed repo is carried as a bare
 *  name in some places and an `owner/name` slug in others. */
function repoTail(repo: string | null | undefined): string | null {
  if (!repo) return null;
  const last = repo.replace(/\\/g, '/').split('/').filter(Boolean).pop();
  return last ? last.toLowerCase() : null;
}

export interface InFlightDeps {
  /** The named ticket's own comment bodies, as plain text. */
  comments(ticket: string): Promise<string[]>;
  /** The named ticket's own remote link URLs. */
  remoteLinks(ticket: string): Promise<string[]>;
  /** What GitHub says the pull request is doing now. Throwing is treated as unknown. */
  stateOf(repo: string, pr: number): Promise<PullRequestState>;
  /**
   * The repository this ticket is routed to. Only a pull request in THAT repository is a
   * claim on this ticket.
   *
   * Without it, a comment citing a pull request in another or a private repository makes
   * the state read fail, the unknown branch refuses, and the ticket is parked forever --
   * a retry re-plans and parks again, with no way out (review, 2026-09-12). A URL from
   * somewhere else is somebody else's work, not an unmeasured claim on this one.
   */
  ownRepo?: string | null;
}

export interface InFlightVerdict {
  start: boolean;
  reason: string;
  /** The pull request the verdict turned on, when there was one. */
  pr?: PullRequestRef;
}

/**
 * Whether work may start on `ticket`. Never reads the ticket's status field -- that is
 * the field that lied.
 */
export async function checkTicketInFlight(ticket: string, deps: InFlightDeps): Promise<InFlightVerdict> {
  let commentBodies: string[];
  let links: string[];
  try {
    [commentBodies, links] = await Promise.all([deps.comments(ticket), deps.remoteLinks(ticket)]);
  } catch (err) {
    // Refusing, not throwing. Throwing propagates out of the planning hop and writes the
    // item to `failed`, which a person has to dig out; a refusal parks it with the real
    // error named and is recoverable (review, 2026-09-12). Either way a tracker that
    // cannot be read is never reported as "no pull request".
    const detail = err instanceof Error ? err.message : String(err);
    return {
      start: false,
      reason: `${ticket}'s comments and remote links could not be read (${detail}), so whether it `
        + 'already has a pull request is unknown; an unmeasured ticket reads as in flight',
    };
  }

  const all = findPullRequestRefs([
    ...commentBodies.map((text) => ({ where: 'comment' as const, text })),
    ...links.map((text) => ({ where: 'remote-link' as const, text })),
  ]);
  const own = repoTail(deps.ownRepo);
  const refs = own === null ? all : all.filter((ref) => repoTail(ref.repo) === own);

  if (refs.length === 0) {
    return { start: true, reason: `${ticket} names no pull request in its comments or remote links` };
  }

  const closed: PullRequestRef[] = [];
  for (const ref of refs) {
    let state: PullRequestState | 'UNKNOWN';
    try {
      state = await deps.stateOf(ref.repo, ref.pr);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        start: false,
        reason: `${ticket} names ${ref.url} in a ${ref.where} and its state could not be read (${detail}); `
          + 'an unmeasured pull request reads as in flight',
        pr: ref,
      };
    }
    if (state === 'OPEN') {
      return {
        start: false,
        reason: `${ticket} already has an open pull request: ${ref.url} (found in a ${ref.where}). `
          + 'Starting it again duplicates work that is in flight.',
        pr: ref,
      };
    }
    if (state === 'MERGED') {
      return {
        start: false,
        reason: `${ticket} already has a merged pull request: ${ref.url} (found in a ${ref.where}). `
          + 'The work landed; the status field is what is out of date.',
        pr: ref,
      };
    }
    closed.push(ref);
  }

  const names = closed.map((ref) => ref.url).join(', ');
  return {
    start: true,
    reason: `${ticket} names only closed, unmerged pull requests (${names}); nothing is in flight`,
    ...(closed[0] ? { pr: closed[0] } : {}),
  };
}
