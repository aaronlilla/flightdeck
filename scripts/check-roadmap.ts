#!/usr/bin/env -S npx tsx
/**
 * R-02 guard #2: `npm run check:roadmap`. Thin CLI wrapper over `roadmap-check.ts`'s
 * pure core -- this file is the only place in the repository allowed to shell out to
 * `gh` for this check, since no test may call it directly (`council/gh.ts`'s own
 * guardrail: no `gh` call in any test).
 *
 * Reads `doctrine/ROADMAP.md`, asks `gh pr list` for every PR this repo has, and prints
 * one line per failure. Exits 1 on any failure, 0 otherwise. A refused `gh` call never
 * fails the run by itself -- it prints one line saying the PR checks were skipped and
 * still runs the local checks.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { GhPrInfo } from '../src/forge/roadmap-check.js';
import { runRoadmapCheck } from '../src/forge/roadmap-check.js';

const REPO = 'aaronlilla/flightdeck';

async function listPrs(): Promise<GhPrInfo[] | null> {
  try {
    const out = execFileSync('gh', [
      'pr', 'list', '--state', 'all', '--repo', REPO,
      '--json', 'number,body,state,mergedAt', '--limit', '200',
    ], { encoding: 'utf8' });
    return JSON.parse(out) as GhPrInfo[];
  } catch {
    return null;
  }
}

export async function main(): Promise<void> {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const roadmapText = readFileSync(path.join(root, 'doctrine', 'ROADMAP.md'), 'utf8');

  const result = await runRoadmapCheck({ roadmapText, listPrs });

  if (result.ghSkipped) {
    console.log('check:roadmap: gh was refused (rate limit or no network); running local checks only');
  }

  if (result.failures.length === 0) {
    console.log('check:roadmap: clean');
    return;
  }

  console.error(`check:roadmap: ${result.failures.length} finding(s)`);
  for (const failure of result.failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
