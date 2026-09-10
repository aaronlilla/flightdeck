#!/usr/bin/env -S npx tsx
/**
 * Local-only: are stream A (the dev-harness hook) and stream B (this repo) still
 * implementing the same readable-PR contract? Compares this repo's committed
 * `src/forge/intake/__fixtures__/readability.json` against the authoring session's
 * shared copy under the `.claude/goals/` directory that sits one level above every repo
 * checkout on the machine both streams are developed on.
 *
 * Not part of `npm run verify` or `npm test`: that path does not exist on a CI runner,
 * which checks out this repo alone, and R-42 forbids skipping a test to clear a red
 * check rather than moving the check to where it can run. This guarantee lives here
 * instead -- run by hand, on the machine where both trees exist and where either file
 * could actually be edited -- which is the only place a real drift could happen.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FIXTURES_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)), 'src', 'forge', 'intake', '__fixtures__');

/** Walks up from this repo's checkout (a main checkout or a worktree -- the two sit at
 *  different depths under `C:/dev`, `C:/dev/flightdeck` vs.
 *  `C:/dev/worktrees/flightdeck--<slug>`) to find the `.claude/goals` directory both
 *  streams share, rather than a fixed relative offset that only one of those shapes. */
function findSharedFixtures(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, '.claude', 'goals', '2026-09-09-readable-pr-rule-specimens', 'fixtures.json');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function main(): void {
  const localPath = path.join(FIXTURES_DIR, 'readability.json');
  const sharedPath = findSharedFixtures(path.resolve(fileURLToPath(new URL('..', import.meta.url))));
  if (!sharedPath) {
    console.error('check:fixture-parity: cannot find the shared source (.claude/goals/2026-09-09-readable-pr-rule-specimens/fixtures.json) above this checkout.');
    console.error('This check only runs on the machine both dev-harness and flightdeck are checked out on.');
    process.exit(1);
  }
  const sharedHash = sha256(sharedPath);
  const localHash = sha256(localPath);
  if (localHash !== sharedHash) {
    console.error('check:fixture-parity: FAILED -- the committed copy has drifted from the shared source');
    console.error(`  local:  ${localPath} (${localHash})`);
    console.error(`  shared: ${sharedPath} (${sharedHash})`);
    process.exit(1);
  }
  console.log('check:fixture-parity: clean -- byte-identical to the shared source');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
