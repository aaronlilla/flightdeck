/**
 * `attest.ts`: where a `CouncilAttestation` lands under `~/.forge` and how it comes back.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { verified } from '../../../src/forge/contracts.ts';
import type { CouncilAttestation } from '../../../src/forge/contracts.ts';
import { attestationPath, readAttestation, writeAttestation } from '../../../src/forge/council/attest.ts';

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-attest-'));
  originalHome = process.env['FORGE_HOME'];
  process.env['FORGE_HOME'] = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env['FORGE_HOME'];
  else process.env['FORGE_HOME'] = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function attestation(overrides: Partial<CouncilAttestation> = {}): CouncilAttestation {
  return {
    repo: 'acme/widgets', pr: 105, head: 'headsha1', base: 'basesha1', round: 1,
    verdict: 'PASS', decidingFindings: [], lenses: [],
    judge: { model: 'claude-opus-5', verdict: 'PASS' },
    ci: { runId: 'run-1', headSha: 'headsha1' },
    at: verified(1000, 'gh pr view'),
    ...overrides,
  };
}

describe('writeAttestation / readAttestation', () => {
  it('round-trips a written attestation through the schema', () => {
    const written = writeAttestation(attestation());
    expect(written).toBe(attestationPath('acme/widgets', 105, 'headsha1'));
    const read = readAttestation('acme/widgets', 105, 'headsha1');
    expect(read?.verdict).toBe('PASS');
    expect(read?.head).toBe('headsha1');
  });

  it('a missing attestation reads as undefined, never a thrown error', () => {
    expect(readAttestation('acme/widgets', 999, 'nope')).toBeUndefined();
  });

  it('a truncated file on disk reads as no attestation rather than throwing', () => {
    writeAttestation(attestation());
    const path = attestationPath('acme/widgets', 105, 'headsha1');
    writeFileSync(path, '{"repo": "acme/widgets"', 'utf8');
    expect(readAttestation('acme/widgets', 105, 'headsha1')).toBeUndefined();
  });
});
