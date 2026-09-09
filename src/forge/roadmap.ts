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

/** R-02 guard #4: whether `text` names any `R-nn` id at all, not necessarily one still
 *  open in the table -- `self/enqueue.ts` uses this on a finding's own summary and
 *  evidence to decide whether it has anything to attach to, before it ever reaches the
 *  roadmap table itself. */
export function citesRoadmapId(text: string): boolean {
  return /\bR-\d{2}\b/.test(text);
}

/** R-02 guard #4: inserts `line` at the end of `text`'s `## Proposed` section, adding the
 *  section (as a new final heading) if the file does not have one yet. Pure so
 *  `enqueue.ts`'s caller can read the real file, transform it here, and write it back
 *  without this module ever touching a filesystem itself. */
export function appendProposedLine(text: string, line: string): string {
  const headingMatch = /^## Proposed\s*$/m.exec(text);
  if (!headingMatch) {
    const trimmed = text.replace(/\n+$/, '');
    return `${trimmed}\n\n## Proposed\n\n${line}\n`;
  }
  const start = headingMatch.index + headingMatch[0].length;
  const rest = text.slice(start);
  const nextHeading = /\n## /.exec(rest);
  const sectionEnd = nextHeading ? start + nextHeading.index : text.length;
  const before = text.slice(0, sectionEnd).replace(/\n+$/, '');
  const after = text.slice(sectionEnd);
  return `${before}\n${line}\n${after}`;
}
