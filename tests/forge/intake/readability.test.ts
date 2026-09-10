import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadContract,
  readabilityVerdict,
  resetReadabilityContractForTests,
  hasSecretShape,
} from '../../../src/forge/intake/readability.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEUTRAL_SPECIMENS_SRC = path.join(__dirname, '..', 'specimens', 'readability');

let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env['FORGE_READABILITY_DIR'];
  resetReadabilityContractForTests();
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env['FORGE_READABILITY_DIR'];
  else process.env['FORGE_READABILITY_DIR'] = originalEnv;
  resetReadabilityContractForTests();
});

describe('loadContract -- data lives on the machine, never in the repo', () => {
  it('never throws on a directory with no contract.json; returns {ok: false}', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'forge-readability-empty-'));
    try {
      const result = loadContract(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('no contract at');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws on a directory that does not exist at all', () => {
    const dir = path.join(tmpdir(), `forge-readability-missing-${Date.now()}`);
    const result = loadContract(dir);
    expect(result.ok).toBe(false);
  });

  it('never throws on a malformed contract.json; returns {ok: false}', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'forge-readability-malformed-'));
    try {
      writeFileSync(path.join(dir, 'contract.json'), '{ not valid json', 'utf8');
      const result = loadContract(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('malformed contract at');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads a well-formed contract.json', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'forge-readability-ok-'));
    try {
      const contract = {
        verdicts: ['DENY', 'ADVISE', 'SILENT'],
        surfaces: ['pr-body'],
        outward_repos: ['acme-app'],
        ticket_key_repos: ['acme-app'],
        ticket_key_pattern: '\\bACME-\\d+\\b',
        banned_words: ['synergy'],
        required_sections: ['What breaks', 'What changes', 'How to run'],
        prose_ceiling_words: { 'pr-body': 150 },
        words_deny_from: '2026-01-01',
        production_ceiling: { lines: 300, files: 5 },
        exempt_globs: ['**/*.test.ts'],
        fence_max_lines: 25,
      };
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'contract.json'), JSON.stringify(contract), 'utf8');
      const result = loadContract(dir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.contract.outward_repos).toEqual(['acme-app']);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readabilityVerdict when the contract is not configured', () => {
  it('is SILENT -- loud (via the caller journaling readability.unconfigured), never a refusal', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'forge-readability-unconfigured-'));
    try {
      process.env['FORGE_READABILITY_DIR'] = dir;
      resetReadabilityContractForTests();
      const result = readabilityVerdict(
        'pr-body',
        'acme-app',
        'no ticket key here',
        'this body has none of the required sections and would DENY if the contract were live',
        undefined,
        '2026-09-10',
      );
      expect(result.verdict).toBe('SILENT');
      expect(result.reason).toContain('not configured');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readabilityVerdict against the neutral in-repo specimen set', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'forge-readability-neutral-'));
    cpSync(NEUTRAL_SPECIMENS_SRC, tempDir, { recursive: true });
    process.env['FORGE_READABILITY_DIR'] = tempDir;
    resetReadabilityContractForTests();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const raw = readFileSync(path.join(NEUTRAL_SPECIMENS_SRC, 'specimens.json'), 'utf8');
  const specimens: any[] = JSON.parse(raw).specimens;

  it('pins the neutral specimen count at 8, so a silently dropped specimen fails here', () => {
    // Independently stated, not derived from `specimens.length` itself -- a specimen
    // silently dropped from the fixture would otherwise pass this the same way it
    // passes the loop below.
    const EXPECTED_NEUTRAL_SPECIMEN_COUNT = 8;
    expect(specimens.length).toBe(EXPECTED_NEUTRAL_SPECIMEN_COUNT);
  });

  for (const specimen of specimens) {
    it(`${specimen.id}: expects ${specimen.expected}`, () => {
      const result = readabilityVerdict(
        specimen.surface,
        specimen.repo ?? null,
        specimen.title ?? '',
        specimen.body ?? '',
        specimen.diff_stats,
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
  it('is proven against a deliberately-broken specimen before being trusted', () => {
    expect(hasSecretShape('ghp_abcdefghijklmnopqrstuvwxyz0123456789').hit).toBe(true);
    expect(hasSecretShape('TEST_DB_CONNECTION_STRING=<your value>').hit).toBe(false);
  });
});
