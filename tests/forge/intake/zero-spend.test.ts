/**
 * Requirement 12 / the brief's own "zero-spend check": no specimen in this stream opens
 * a live Codex, Jira, Sentry, or CloudWatch connection. Falsifier named in the brief: a
 * silent fallback to a real call on fixture-load failure would still show green, so this
 * scans for the actual client imports a live call would require (never just trusting
 * that today's tests happen not to crash), and separately proves the fixture path is
 * the one actually exercised by asserting a fake sink's call count is nonzero.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createFakeJiraSink, ensureTicketForFinding } from '../../../src/forge/intake/jiraProjection.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC_INTAKE = join(HERE, '..', '..', '..', 'src', 'forge', 'intake');
const TEST_INTAKE = HERE;

// Real clients a live call would need. `execFileSync`/`python` is exempted ONLY for the
// local, non-network authorship_guard.py check in voice-guard.test.ts, named explicitly
// below rather than broadly allowed.
// Executable-looking usage only, never a bare mention: reasoner.ts, for instance, is
// allowed to say IN A COMMENT that codex_call.py exists and is out of scope, but any
// file that actually spawns/execs it (or imports a real network client) fails this.
const LIVE_CLIENT_PATTERNS = [
  /from ['"]node:https['"]/, /from ['"]node-fetch['"]/, /from ['"]axios['"]/,
  /from ['"]@aws-sdk\//, /\bfetch\(/,
  /(?:execFileSync|execSync|spawn|spawnSync)\([^)]*codex_call\.py/,
];
// voice-guard.test.ts shells to the LOCAL hook script only, no network. This file itself
// is exempt too: it necessarily quotes the very patterns it scans for.
const EXEMPT_FILES = new Set(['voice-guard.test.ts', 'zero-spend.test.ts']);

function scanDir(dir: string): void {
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || EXEMPT_FILES.has(file)) continue;
    const text = readFileSync(join(dir, file), 'utf8');
    for (const pattern of LIVE_CLIENT_PATTERNS) {
      expect(pattern.test(text), `${file} matched a live-client pattern (${pattern})`).toBe(false);
    }
  }
}

describe('zero-spend: no live client anywhere in this stream', () => {
  it('src/forge/intake carries no real Jira/Sentry/CloudWatch/Codex client', () => {
    scanDir(SRC_INTAKE);
  });

  it('tests/forge/intake carries no real Jira/Sentry/CloudWatch/Codex client (voice-guard.test.ts excepted: local hook only)', () => {
    scanDir(TEST_INTAKE);
  });
});

describe('zero-spend falsifier: the fixture path must actually run, not just fail to crash', () => {
  it('a fixture-backed write really reaches the fake sink — call count is nonzero, never silently skipped', async () => {
    const jira = createFakeJiraSink();
    await ensureTicketForFinding(jira, 'SENTRY-ZS-1', {
      id: 'pkt', ticket: '', what: 'x', where: 'x', evidence: [], confidence: 'low',
      repo: 'x', blockedBy: [], at: 1,
    });
    // The falsifier: a caller whose fixture failed to load and silently fell through to
    // "no write happened" would ALSO show `size === 0` here reading as an empty ticket
    // set rather than a real create -- asserting exactly 1 (not merely > 0, and not
    // merely "did not throw") is what catches that silent fallback.
    expect(jira.tickets.size).toBe(1);
  });
});
