/**
 * Item 4 (R-59, 2026-09-10): the readability rule is loud, not fail-closed, when this
 * machine has no contract. `forge up` calls `initReadabilityAndJournal` once; a missing
 * contract journals `readability.unconfigured` and the Settings line says so, but no
 * write is ever refused just because the rule is unconfigured -- see
 * `src/forge/console/readability-status.ts`.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Journal, replay } from '../../../src/forge/journal.ts';
import {
  initReadabilityAndJournal,
  readabilityStatusLine,
} from '../../../src/forge/console/readability-status.ts';
import {
  readabilityVerdict,
  resetReadabilityContractForTests,
} from '../../../src/forge/intake/readability.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

let dir: string;
let journalPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'console-readability-'));
  journalPath = join(dir, 'fleet.jsonl');
  new Journal(journalPath).close();
});

afterEach(() => {
  delete process.env['FORGE_READABILITY_DIR'];
  resetReadabilityContractForTests();
  rmSync(dir, { recursive: true, force: true });
});

const OVER_CEILING = Array.from({ length: 90 }, (_v, i) => `word${i}`).join(' ');

describe('an empty readability dir -- unconfigured, loud, never fail-closed', () => {
  beforeEach(() => {
    const emptyDir = join(dir, 'readability-empty');
    mkdirSync(emptyDir, { recursive: true });
    process.env['FORGE_READABILITY_DIR'] = emptyDir;
    resetReadabilityContractForTests();
  });

  it('journals exactly one readability.unconfigured row', () => {
    const journal = new Journal(journalPath);
    initReadabilityAndJournal(journal);
    journal.close();
    const state = replay(journalPath);
    const rows = state.events.filter((e) => e.event === 'readability.unconfigured');
    expect(rows).toHaveLength(1);
  });

  it('the Settings page shows the not-configured line', () => {
    const journal = new Journal(journalPath);
    const state = initReadabilityAndJournal(journal);
    journal.close();
    expect(readabilityStatusLine(state)).toContain('not configured');
  });

  it('an over-ceiling comment is NOT refused -- unconfigured is silent, not fail-closed', () => {
    const journal = new Journal(journalPath);
    initReadabilityAndJournal(journal);
    journal.close();
    const result = readabilityVerdict('pr-comment', 'acme-app', '', OVER_CEILING, undefined, '2026-09-10');
    expect(result.verdict).not.toBe('DENY');
  });
});

describe('the neutral contract present -- on, and a real refusal fires', () => {
  const NEUTRAL_CONTRACT_DIR = join(__dirname, '..', 'specimens', 'readability');

  beforeEach(() => {
    process.env['FORGE_READABILITY_DIR'] = NEUTRAL_CONTRACT_DIR;
    resetReadabilityContractForTests();
  });

  it('journals no readability.unconfigured row', () => {
    const journal = new Journal(journalPath);
    initReadabilityAndJournal(journal);
    journal.close();
    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'readability.unconfigured')).toBe(false);
  });

  it('the Settings page shows the on-line naming the outward repo count', () => {
    const journal = new Journal(journalPath);
    const state = initReadabilityAndJournal(journal);
    journal.close();
    expect(readabilityStatusLine(state)).toMatch(/^Readability rule: on, \d+ outward repo\(s\)$/);
  });

  it('an over-ceiling comment on an outward repo IS refused', () => {
    const journal = new Journal(journalPath);
    initReadabilityAndJournal(journal);
    journal.close();
    const result = readabilityVerdict('pr-comment', 'acme-app', '', OVER_CEILING, undefined, '2026-09-10');
    expect(result.verdict).toBe('DENY');
  });
});
