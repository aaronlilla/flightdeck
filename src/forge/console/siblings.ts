/**
 * One ticket, two repositories.
 *
 * A ticket whose fix needs both halves becomes two queue items, and nothing joined them:
 * `repo` and `ticket` are each a single string on an item, so two halves of one ticket
 * were two unrelated rows that happened to share a key. The board showed two tickets.
 * Worse, nothing stopped the frontend half merging before the backend half it calls into
 * existed -- Aaron, 2026-09-13: the backend request opens and the frontend is held until
 * it merges.
 *
 * Deliberately repository-agnostic. Which half waits for which is the caller's decision,
 * carried on the item as `waitingFor`, because this repository must not know the names of
 * anybody's projects.
 */

export interface SiblingItem {
  id: string;
  ticket: string | null;
  repo: string | null;
  state: string;
  /** The id of the sibling that has to land first, when one does. Set by whoever split
   *  the ticket; never inferred from a repository name here. */
  waitingFor: string | null;
}

export interface SiblingLink {
  /** The other item working this ticket, or null. */
  sibling: string | null;
  /** Set when the ticket has more halves than can be paired without guessing. The link
   *  is left empty rather than guessed, because a wrong pairing holds the wrong half. */
  ambiguous: string;
}

/**
 * Pairs the items that are two halves of one ticket, by id.
 *
 * Two items in the SAME repository are a split of that repository's own work, not a
 * cross-repository ticket, so they are left alone: linking them would have the board
 * saying it waits on something it does not.
 */
export function linkSiblings(items: readonly SiblingItem[]): Record<string, SiblingLink> {
  const byTicket = new Map<string, SiblingItem[]>();
  for (const row of items) {
    if (!row.ticket) continue;          // nothing to pair on; ticketless rows are not siblings
    const group = byTicket.get(row.ticket) ?? [];
    group.push(row);
    byTicket.set(row.ticket, group);
  }

  const out: Record<string, SiblingLink> = {};
  for (const row of items) out[row.id] = { sibling: null, ambiguous: '' };

  for (const [ticket, group] of byTicket) {
    if (group.length < 2) continue;
    if (group.length > 2) {
      // Three or more cannot be paired without deciding which two belong together, and a
      // wrong guess holds the wrong half. Say it instead.
      for (const row of group) {
        out[row.id] = {
          sibling: null,
          ambiguous: `${group.length} items are working ${ticket}; a ticket is linked across two, and this needs a person to say which two`,
        };
      }
      continue;
    }
    const [first, second] = group as [SiblingItem, SiblingItem];
    if (first.repo && second.repo && first.repo === second.repo) continue;
    out[first.id] = { sibling: second.id, ambiguous: '' };
    out[second.id] = { sibling: first.id, ambiguous: '' };
  }
  return out;
}

export interface HoldState {
  held: boolean;
  /** Why it is held, or why a hold that was expected is not in force. Empty only when
   *  the item was never waiting for anything, or its sibling genuinely finished. */
  why: string;
}

/** The states that mean a half has actually landed. Anything else -- failed, parked,
 *  still running -- has not, and releasing on those would let the half that depends on
 *  it merge into a gap. */
const FINISHED = new Set(['done']);

/**
 * Whether this item is held waiting for the half that has to land first.
 *
 * A sibling that has gone missing releases the hold and says so, rather than holding for
 * ever or releasing quietly: the reason it was held has not been met, it has disappeared,
 * and those are different things for a person to read.
 */
export function holdState(item: SiblingItem, items: readonly SiblingItem[]): HoldState {
  if (!item.waitingFor) return { held: false, why: '' };

  const other = items.find((row) => row.id === item.waitingFor);
  if (!other) {
    return {
      held: false,
      why: `it was waiting for ${item.waitingFor}, which is no longer on the board`,
    };
  }
  if (FINISHED.has(other.state)) return { held: false, why: '' };

  const where = other.repo ?? other.id;
  return {
    held: true,
    why: other.state === 'failed'
      ? `the half in ${where} failed, so this one is still held`
      : `waiting for the half in ${where}, which is ${other.state}`,
  };
}
