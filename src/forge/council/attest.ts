/**
 * Where a `CouncilAttestation` lives and how it comes back off disk. `contracts.ts`
 * already declares the shape and `attestationRelPath`'s own relative path; this file is
 * the one place that joins that path against `~/.forge` (`paths.ts`'s own convention),
 * redacts before it ever touches disk (`redact-sinks.ts`'s sink 2), and validates a read
 * back against the same schema a write was checked against -- a hand-edited or truncated
 * file reads as "no attestation" rather than a thrown parse error the gate would have to
 * catch everywhere it reads one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { attestationRelPath, CouncilAttestationSchema } from '../contracts.ts';
import type { CouncilAttestation } from '../contracts.ts';
import { forgeHome } from '../paths.ts';
import { redactAttestationForJournal } from './redact-sinks.ts';

export function attestationPath(repo: string, pr: number, head: string): string {
  return join(forgeHome(), attestationRelPath(repo, pr, head));
}

export function writeAttestation(attestation: CouncilAttestation): string {
  const path = attestationPath(attestation.repo, attestation.pr, attestation.head);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(redactAttestationForJournal(attestation), null, 2), 'utf8');
  return path;
}

export function readAttestation(repo: string, pr: number, head: string): CouncilAttestation | undefined {
  return readAttestationAtPath(attestationPath(repo, pr, head));
}

/** The board's own `plain` sentence (H1.2 fix) knows a queue item's `attestationPath`
 *  straight off the item -- the path the gate already resolved when it wrote the
 *  attestation -- so it never needs a PR's head sha to find the file. Same validation
 *  and same honest "nothing readable" answer as `readAttestation`. */
export function readAttestationAtPath(path: string): CouncilAttestation | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  const result = CouncilAttestationSchema.safeParse(parsed);
  return result.success ? (result.data as CouncilAttestation) : undefined;
}
