/**
 * Requirement 11 — Governor coalesces EAS builds, Warden owns single-flight credential
 * recovery. F23/F24 are deferred to Intake's neighbors, not solved inside Intake alone
 * (spine spec "the lanes"). This specimen's falsifier is the opposite of the usual
 * shape: it fails if this stream DOES implement either concern, and it scans the actual
 * source tree rather than trusting a comment, so a future edit that quietly adds a
 * coalescing or credential-recovery routine here breaks the build.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFERRED_TO_NEIGHBORS } from '../../../src/forge/intake/boundary.js';

const INTAKE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'src', 'forge', 'intake');

const FORBIDDEN_IMPLEMENTATION_NAMES = [
  /function\s+coalesceEasBuilds/i,
  /function\s+recoverCredentials/i,
  /function\s+singleFlightCredentialRecovery/i,
];

describe('DEFERRED_TO_NEIGHBORS', () => {
  it('names both F23/F24 concerns as owned elsewhere, not by Intake', () => {
    expect(DEFERRED_TO_NEIGHBORS).toEqual(
      expect.arrayContaining([
        { concern: 'eas-build-coalescing', owner: 'governor' },
        { concern: 'single-flight-credential-recovery', owner: 'warden' },
      ]),
    );
  });
});

describe('Intake never implements a deferred concern itself', () => {
  it('no file under src/forge/intake defines a coalescing or credential-recovery function', () => {
    const files = readdirSync(INTAKE_DIR).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      const text = readFileSync(join(INTAKE_DIR, file), 'utf8');
      for (const pattern of FORBIDDEN_IMPLEMENTATION_NAMES) {
        expect(pattern.test(text), `${file} appears to implement a deferred concern`).toBe(false);
      }
    }
  });
});
