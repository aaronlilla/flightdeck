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
import { existsSync, readFileSync } from 'node:fs';

import { firstBodyParagraph, titleFromHeading } from './lanes.js';
import type { QueueItem } from '../../shared/console-model.js';

function headingOfFile(path: string | null, ticket: string | null): string | null {
  if (!path || !existsSync(path)) return null;
  try {
    return titleFromHeading(readFileSync(path, 'utf8'), ticket);
  } catch {
    return null;
  }
}

/** `null` when nothing on the item can name it -- a ticket with no brief written yet.
 *  The card falls back to the ticket key, then the id, so it is never blank. */
export function queueTitleFor(item: QueueItem): string | null {
  if (item.source === 'brief' || item.source === 'hotfix') {
    return titleFromHeading(item.input, item.ticket) ?? firstBodyParagraph(item.input);
  }
  return headingOfFile(item.briefPath, item.ticket);
}
