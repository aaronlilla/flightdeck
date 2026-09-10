#!/usr/bin/env tsx
/**
 * Local-only proof that the real, installed readability contract (`~/.forge/readability`,
 * written by dev-harness's `install.ps1`) still agrees with every flightdeck-scoped
 * specimen in the real fixtures file -- the same live check `check-fixture-parity.ts`
 * used to run against a vendored copy, now pointed at the machine instead of the repo.
 *
 * Not part of `verify`, not run in CI: CI has no install and no `~/.forge`, so this can
 * only run where `install.ps1` has already landed the real contract. Run by hand:
 *   npm run check:readability-parity
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readabilityDir } from '../src/forge/paths.ts';
import {
  loadContract,
  readabilityVerdict,
  resetReadabilityContractForTests,
} from '../src/forge/intake/readability.ts';

function main(): number {
  const dir = readabilityDir();
  const contractResult = loadContract(dir);
  if (!contractResult.ok) {
    console.error(`no installed contract at ${dir}: ${contractResult.reason}`);
    console.error('run install.ps1 on this machine first, then re-run this check.');
    return 1;
  }

  const specimensDir = join(dir, 'specimens');
  const fixturesPath = join(specimensDir, 'fixtures.json');
  if (!existsSync(fixturesPath)) {
    console.error(`no installed specimens at ${fixturesPath}`);
    return 1;
  }

  process.env['FORGE_READABILITY_DIR'] = dir;
  resetReadabilityContractForTests();

  const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8')) as {
    specimens: Array<{
      id: string; surface: string; repo?: string | null; title?: string; body?: string;
      body_file?: string; scope: string[]; diff_stats?: unknown; as_of: string;
      expected: string; reason_contains?: string[];
    }>;
  };

  const flightdeckSpecimens = fixtures.specimens.filter((s) => s.scope.includes('flightdeck'));
  let failures = 0;
  for (const specimen of flightdeckSpecimens) {
    const body = specimen.body ?? (specimen.body_file
      ? readFileSync(join(specimensDir, specimen.body_file), 'utf8')
      : '');
    const result = readabilityVerdict(
      specimen.surface,
      specimen.repo ?? null,
      specimen.title ?? '',
      body,
      specimen.diff_stats as never,
      specimen.as_of,
    );
    if (result.verdict !== specimen.expected) {
      failures += 1;
      console.error(`FAIL ${specimen.id}: expected ${specimen.expected}, got ${result.verdict} (${result.reason})`);
      continue;
    }
    for (const substring of specimen.reason_contains ?? []) {
      if (!result.reason.toLowerCase().includes(substring.toLowerCase())) {
        failures += 1;
        console.error(`FAIL ${specimen.id}: reason "${result.reason}" does not contain "${substring}"`);
      }
    }
  }

  console.log(`${flightdeckSpecimens.length} specimens, ${failures} failures`);
  return failures > 0 ? 1 : 0;
}

process.exit(main());
