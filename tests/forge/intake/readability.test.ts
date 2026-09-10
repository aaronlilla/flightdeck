import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readabilityVerdict } from '../../../src/forge/intake/readability.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', '..', '..', 'src', 'forge', 'intake', '__fixtures__');

const fixtures = JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'readability.json'), 'utf8'));

// The byte-identity check against the shared authoring-machine copy
// (`C:/dev/.claude/goals/...`, outside this repo and outside any CI checkout) lives in
// `scripts/check-fixture-parity.ts` (`npm run check:fixture-parity`) instead of here: a
// CI runner structurally cannot have that path, and R-42 forbids skipping a test to clear
// a red check rather than moving the check to where it can actually run. Every vitest
// specimen below still reads the committed copy in this repo, so CI keeps proving those.

describe('readabilityVerdict against shared specimens', () => {
  const flightdeckSpecimens = fixtures.specimens.filter((s: any) => s.scope.includes('flightdeck'));

  it('runs every flightdeck-scoped specimen (count matches jq)', () => {
    // Independently derived via:
    //   jq '[.specimens[] | select(.scope | index("flightdeck"))] | length' fixtures.json
    // Do not compute this the same way the suite does -- that would make the assertion
    // tautological (comparing the filter to itself) and could never catch a specimen
    // silently dropped from `flightdeckSpecimens` before this test sees it.
    const EXPECTED_FLIGHTDECK_SPECIMEN_COUNT = 27;
    // eslint-disable-next-line no-console
    console.log(`flightdeck-scoped specimens run: ${flightdeckSpecimens.length}`);
    expect(flightdeckSpecimens.length).toBe(EXPECTED_FLIGHTDECK_SPECIMEN_COUNT);
  });

  for (const specimen of flightdeckSpecimens) {
    it(`${specimen.id}: expects ${specimen.expected}`, () => {
      const body = specimen.body ?? (specimen.body_file
        ? readFileSync(path.join(FIXTURES_DIR, specimen.body_file), 'utf8')
        : '');
      const result = readabilityVerdict(
        specimen.surface,
        specimen.repo ?? null,
        specimen.title ?? '',
        body,
        Object.prototype.hasOwnProperty.call(specimen, 'diff_stats') ? specimen.diff_stats : undefined,
        specimen.as_of,
      );
      expect(result.verdict).toBe(specimen.expected);
      for (const substring of specimen.reason_contains ?? []) {
        expect(result.reason.toLowerCase()).toContain(String(substring).toLowerCase());
      }
    });
  }
});

describe('hasSecretShape', () => {
  it('is proven against a deliberately-broken specimen before being trusted', async () => {
    const { hasSecretShape } = await import('../../../src/forge/intake/readability.ts');
    // Red check: a naive matcher that never fires would pass a suite with no assertions
    // on the negative case, so assert both directions explicitly.
    expect(hasSecretShape('ghp_abcdefghijklmnopqrstuvwxyz0123456789').hit).toBe(true);
    expect(hasSecretShape('TEST_DB_CONNECTION_STRING=<your value>').hit).toBe(false);
  });
});
