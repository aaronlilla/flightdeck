import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ticketFromBrief } from '../intake/repoRoute.js';

/**
 * A lane's own brief, found by the lane's id rather than through its queue row.
 *
 * The escape, measured live on 2026-09-12: a board tile read `No ticket` over
 * `Untitled run` while the brief on disk behind it began
 *
 *     # Goal: card declines and Worldpay timeouts leave the API as real errors,
 *       not a bare 500 (BBZ-224, backend half)
 *     ticket: BBZ-224
 *
 * A lane's brief path is resolved through the queue row whose `runKey` matches it, and
 * that row is pruned once the item finishes. So a brief lane loses its title AND its
 * ticket key at the moment it completes, which is the moment somebody is most likely to
 * be looking at it. Aaron: "Every board item should be a ticket being worked on, never
 * unnamed, never confusing, never vague."
 *
 * The file never moved. `writeBrief` names it after the id it was minted with, and for a
 * pasted brief or a hotfix that id IS the run key -- so the lane can find its own brief
 * with no queue row at all.
 */

/**
 * Lane ids whose brief file is named after the lane itself.
 *
 * Deliberately NOT every kind. A ticket lane's brief is named by `briefIdFor(packetId,
 * itemId)`, which is not its run key, so looking one up by lane id would read some other
 * ticket's brief or none at all. Guessing there would be worse than the blank it replaces.
 */
const SELF_NAMED_PREFIXES = ['queue-brief-', 'hotfix-'];

export function briefIsSelfNamed(laneId: string): boolean {
  return SELF_NAMED_PREFIXES.some((prefix) => laneId.startsWith(prefix));
}

/** The same sanitising `writeBrief` applies before it names the file. */
function fileNameFor(laneId: string): string {
  return `${laneId.replace(/[^A-Za-z0-9._-]/g, '_')}.md`;
}

/**
 * The path to this lane's own brief, or null when the lane is not one whose brief is
 * named after it, or when no such file exists.
 */
export function briefPathForLane(forgeHomeDir: string, laneId: string): string | null {
  if (!briefIsSelfNamed(laneId)) return null;
  const path = join(forgeHomeDir, 'queue', 'briefs', fileNameFor(laneId));
  return existsSync(path) ? path : null;
}

export interface BriefFacts {
  /** The `ticket: KEY-123` line, when the brief carries one. */
  ticket: string | null;
}

/**
 * What a brief says about itself beyond its heading. Read through a cache keyed on the
 * file's own stamp, because this runs once per lane on every poll and a brief does not
 * change between them.
 */
const cache = new Map<string, { key: string; facts: BriefFacts }>();

export function briefFacts(path: string): BriefFacts {
  let key: string;
  try {
    const stat = statSync(path);
    key = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return { ticket: null };
  }
  const hit = cache.get(path);
  if (hit?.key === key) return hit.facts;
  try {
    const facts: BriefFacts = { ticket: ticketFromBrief(readFileSync(path, 'utf8')) };
    cache.set(path, { key, facts });
    return facts;
  } catch {
    return { ticket: null };
  }
}

/** Test seam: drops the parse cache. */
export function clearBriefFactsCache(): void {
  cache.clear();
}
