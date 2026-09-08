/**
 * The one line a person reads on a queue card.
 *
 * A queued brief carries its whole markdown text as `input` -- `briefTextFrom` in
 * `queue-route.ts` resolves a `.md` path to the file's contents at add time -- so a card
 * that printed `input` printed the brief. This names the item instead, reusing the
 * heading rules the board's lane tiles already use (`titleFromHeading`), and reading a
 * ticket item's brief off disk the same way `reads.ts` does for a lane.
 *
 * It runs on the way out of `GET /queue`, never on the way in: an item written to disk
 * before `title` existed answers with one, and no migration ever has to run.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';

import { firstBodyParagraph, titleFromHeading } from './lanes.js';
import type { QueueItem } from '../../shared/console-model.js';

const LEADING_SEPARATOR = /^[,;:\-–—]+\s*/;

/** `GET /queue` answers a 5s poll and every SSE-driven refresh, and a ticket item's
 *  title comes off a brief on disk. Reading every brief on every one of those was a
 *  blocking read per item per request, so the heading is kept against the file's own
 *  mtime and size: an edited brief still retitles on the next read, an unchanged one
 *  costs a `stat`. */
interface CachedHeading { mtimeMs: number; size: number; ticket: string | null; heading: string | null }
const headingCache = new Map<string, CachedHeading>();

function headingOfFile(path: string | null, ticket: string | null): string | null {
  if (!path) return null;
  let stamp: { mtimeMs: number; size: number };
  try {
    if (!existsSync(path)) {
      headingCache.delete(path);
      return null;
    }
    const stat = statSync(path);
    stamp = { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
  const cached = headingCache.get(path);
  if (cached && cached.mtimeMs === stamp.mtimeMs && cached.size === stamp.size && cached.ticket === ticket) {
    return cached.heading;
  }
  let heading: string | null = null;
  try {
    heading = titleFromHeading(readFileSync(path, 'utf8'), ticket);
  } catch {
    return null;
  }
  headingCache.set(path, { ...stamp, ticket, heading });
  return heading;
}

/** `titleFromHeading` removes the ticket key and nothing else, so a heading written
 *  `# Goal: BBZ-233, a valid Plaid identity pass reads as a failure` comes back as
 *  `, a valid Plaid identity pass...` -- seen on the live queue on 2026-09-08. The
 *  separator that followed the key comes off here, and the sentence it leaves behind
 *  starts with a capital. Lane tiles read the same rule and still show the fragment;
 *  fixing it there changes every lane title at once and belongs in its own change. */
function withoutOrphanedPunctuation(title: string | null): string | null {
  if (title === null) return null;
  const trimmed = title.replace(LEADING_SEPARATOR, '');
  // Nothing left once the separator comes off (a heading of `# BBZ-233 -`): null, so the
  // caller's own fallback runs. Returning the bare dash would name the card after it.
  if (!trimmed) return null;
  if (trimmed === title) return title;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** `null` when nothing on the item can name it -- a ticket with no brief written yet.
 *  The card falls back to the ticket key, then the id, so it is never blank. */
export function queueTitleFor(item: QueueItem): string | null {
  if (item.source === 'brief' || item.source === 'hotfix') {
    return withoutOrphanedPunctuation(titleFromHeading(item.input, item.ticket)) ?? firstBodyParagraph(item.input);
  }
  return withoutOrphanedPunctuation(headingOfFile(item.briefPath, item.ticket));
}
