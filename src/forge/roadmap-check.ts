/**
 * `npm run check:roadmap`'s pure core (R-02 guard #2): reuses `parseRoadmapItems`
 * (`roadmap.ts`) rather than reading the Items table a second way, and checks the
 * `## The goal` paragraph's pinned hash, every done row's `pr` cell, every open PR's
 * body, and every `pr` cell's target against `gh`.
 *
 * `gh` reachability is injected as `listPrs`, returning `null` when `gh` was refused
 * (rate limit, no network). The two local checks (goal hash, done row missing a `pr`
 * cell) always run; the three `gh`-dependent checks are skipped, with one line saying
 * so, when `listPrs` returns `null` -- this module never fails a run just because `gh`
 * was unreachable.
 */
import { createHash } from 'node:crypto';

import { citesRoadmapId, parseRoadmapItems } from './roadmap.js';

export interface GhPrInfo {
  number: number;
  body: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergedAt: string | null;
}

export interface RoadmapCheckDeps {
  roadmapText: string;
  /** Returns every PR gh knows about, open and closed, or `null` when gh itself could
   *  not be asked (rate limit, no network, not authenticated). */
  listPrs: () => Promise<GhPrInfo[] | null>;
}

export interface RoadmapCheckResult {
  failures: string[];
  ghSkipped: boolean;
}

/** The raw text of the `## The goal` section: everything from just past its heading up
 *  to the next `## ` heading, or to the end of the file if there isn't one. Undefined if
 *  the file has no `## The goal` heading at all.
 *
 *  Finds the boundary by plain index rather than a `$`-terminated regex. With the `m`
 *  flag, `$` matches before every line break, not just the end of the file, so a lazy
 *  `([\s\S]*?)(?:\n## |\n?$)` capture stops at the section's first blank line instead of
 *  its next heading. `appendProposedLine` already sidesteps this the same way. */
function goalSection(text: string): string | undefined {
  const headingMatch = /^## The goal\s*\n/m.exec(text);
  if (!headingMatch) return undefined;
  const start = headingMatch.index + headingMatch[0].length;
  const rest = text.slice(start);
  const nextHeadingIndex = rest.search(/\n## /);
  return nextHeadingIndex === -1 ? rest : rest.slice(0, nextHeadingIndex);
}

/** The `## The goal` section's first paragraph -- the text the pinned hash actually
 *  covers. `doctrine/ROADMAP.md` puts an attribution line ("Aaron, ...  Only Aaron
 *  edits this paragraph.") after it in the same section; that line is what states the
 *  paragraph above it is the protected one, so the hash is scoped to match: everything
 *  up to the section's first blank line, comments stripped, trimmed. Returns undefined
 *  if the file has no `## The goal` heading at all. */
export function goalParagraph(text: string): string | undefined {
  const section = goalSection(text);
  if (section === undefined) return undefined;
  const withoutComments = section.replace(/<!--[\s\S]*?-->/g, '');
  const paragraphs = withoutComments.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paragraphs[0] ?? '';
}

/** The `goal-sha256` hex value pinned in a comment inside the `## The goal` section, or
 *  undefined if that section carries no such comment. */
export function pinnedGoalHash(text: string): string | undefined {
  const section = goalSection(text);
  if (section === undefined) return undefined;
  const hashMatch = /<!--\s*goal-sha256:\s*([0-9a-f]{64})\s*-->/.exec(section);
  return hashMatch?.[1];
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The PR number a row's `pr` cell names, or undefined for a cell with no `#nn` in it
 *  (`this PR`, a bare URL, or empty -- none of those are checkable against `gh`). */
function prNumberIn(cell: string): number | undefined {
  const match = /#(\d+)/.exec(cell);
  return match ? Number(match[1]) : undefined;
}

export async function runRoadmapCheck(deps: RoadmapCheckDeps): Promise<RoadmapCheckResult> {
  const failures: string[] = [];

  const paragraph = goalParagraph(deps.roadmapText);
  const pinned = paragraph === undefined ? undefined : pinnedGoalHash(deps.roadmapText);
  if (paragraph === undefined) {
    failures.push('doctrine/ROADMAP.md has no "## The goal" section');
  } else if (!pinned) {
    failures.push('doctrine/ROADMAP.md\'s "## The goal" section has no <!-- goal-sha256: ... --> comment');
  } else if (pinned !== sha256(paragraph)) {
    failures.push('doctrine/ROADMAP.md\'s goal paragraph does not match its pinned goal-sha256 comment');
  }

  const items = parseRoadmapItems(deps.roadmapText);
  for (const item of items) {
    if (item.status.trim().toLowerCase() === 'done' && item.pr.trim() === '') {
      failures.push(`${item.id} is marked done but its pr cell is empty`);
    }
  }

  const prs = await deps.listPrs();
  const ghSkipped = prs === null;

  if (prs !== null) {
    for (const pr of prs) {
      if (pr.state === 'OPEN' && !citesRoadmapId(pr.body)) {
        failures.push(`PR #${pr.number} is open and its body cites no R-nn id`);
      }
    }

    const byNumber = new Map(prs.map((pr) => [pr.number, pr] as const));
    for (const item of items) {
      const prNumber = prNumberIn(item.pr);
      if (prNumber === undefined) continue;
      const pr = byNumber.get(prNumber);
      if (!pr) {
        failures.push(`${item.id}'s pr cell names #${prNumber}, which gh does not know about`);
        continue;
      }
      if (item.status.trim().toLowerCase() === 'done' && pr.state !== 'MERGED') {
        failures.push(`${item.id} is marked done but #${prNumber} is not merged (state: ${pr.state})`);
      }
    }
  }

  return { failures, ghSkipped };
}
