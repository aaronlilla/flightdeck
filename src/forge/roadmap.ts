/**
 * Parsing for `doctrine/ROADMAP.md`'s `## Items` table.
 *
 * R-02 guard #1 (`intake/queue.ts#addBriefItem`) needs one question answered: does this
 * id name a row that is still open? This module owns that parsing so guard #2
 * (`npm run check:roadmap`, not yet built) can reuse it instead of a second parser
 * reading the same table a different way.
 */

export interface RoadmapItem {
  id: string;
  status: string;
  pr: string;
}

function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
}

/** Every `| R-nn | delivers | serves | status | pr | proof |` row in the Items table, in
 *  file order. The header row (`| id | ... |`) and the separator row (`| --- | ... |`)
 *  are skipped on their own: neither's first cell matches `R-\d{2}`. */
export function parseRoadmapItems(text: string): RoadmapItem[] {
  const items: RoadmapItem[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = splitRow(line);
    if (!cells || cells.length < 5) continue;
    const [id, , , status, pr] = cells;
    if (!id || !/^R-\d{2}$/.test(id)) continue;
    items.push({ id, status: status ?? '', pr: pr ?? '' });
  }
  return items;
}

/** Whether `id` names a row in the Items table whose status is not `done`. False both
 *  for an id the table never names at all and for one already marked done -- a brief
 *  citing either has no open roadmap work to attach to. */
export function roadmapIdOpen(text: string, id: string): boolean {
  const item = parseRoadmapItems(text).find((row) => row.id === id);
  return item !== undefined && item.status.trim().toLowerCase() !== 'done';
}
