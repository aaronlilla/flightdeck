/**
 * Item 1 of the ticket-friction goal: three outward texts cost five rewrites between them
 * because the readability contract and the authorship guard only speak when a write is
 * attempted. The specimens below are the shapes that were actually refused on one ticket:
 * a 174-word pull request body against a 150-word ceiling, a 157-word issue comment
 * against an 80-word ceiling, and a body documenting two of three production files.
 *
 * The point of every assertion here is that ONE pass reports ALL of them, before any
 * write is attempted, with the ceiling and the count named for each -- and that the
 * ceiling is read from the contract file rather than baked into the checker (the
 * "moves with the contract" specimen edits the file and expects the reported number to
 * follow).
 *
 * The attribution specimen is assembled from fragments at run time, the same way
 * `tests/checks/agnostic.ts` assembles the strings it hunts for: written as a literal it
 * would be a real attribution claim sitting in a tracked file, and the operator's own
 * authorship guard refuses to write the file at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetReadabilityContractForTests } from '../../../src/forge/intake/readability.ts';
import { checkOutwardDraft, formatDraftReport } from '../../../src/forge/intake/draftCheck.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEUTRAL_SPECIMENS_SRC = path.join(__dirname, '..', 'specimens', 'readability');

const AS_OF = '2026-09-12';

/** The co-author trailer, assembled rather than written out -- see the header. */
const ATTRIBUTION_TRAILER = ['Co-Authored', '-By: ', 'Cla', 'ude'].join('');

let contractDir: string;
let originalEnv: string | undefined;

/** `n` words of neutral filler -- no banned word, no backtick, no heading. */
function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
}

function pathHeading(file: string, line: number, code: string): string {
  return [`### ${file}:${line}`, '', '```ts', code, '```'].join('\n');
}

/** The refused body: both required sections, two of the three production files
 *  documented, and 174 words of prose. */
function prBody174(): string {
  return [
    '## What breaks',
    '',
    words(87),
    '',
    '## What changes',
    '',
    words(87),
    '',
    pathHeading('src/one.ts', 10, 'const one = 1;'),
    '',
    pathHeading('src/two.ts', 20, 'const two = 2;'),
  ].join('\n');
}

/** The body that fits: same shape, all three files documented, prose under the ceiling. */
function prBodyThatFits(): string {
  return [
    '## What breaks',
    '',
    words(20),
    '',
    '## What changes',
    '',
    words(20),
    '',
    pathHeading('src/one.ts', 10, 'const one = 1;'),
    '',
    pathHeading('src/two.ts', 20, 'const two = 2;'),
    '',
    pathHeading('src/three.ts', 30, 'const three = 3;'),
  ].join('\n');
}

const THREE_PRODUCTION_FILES = [
  { path: 'src/one.ts', added: 10, deleted: 0 },
  { path: 'src/two.ts', added: 10, deleted: 0 },
  { path: 'src/three.ts', added: 10, deleted: 0 },
];

beforeEach(() => {
  originalEnv = process.env['FORGE_READABILITY_DIR'];
  contractDir = mkdtempSync(path.join(tmpdir(), 'forge-draftcheck-'));
  cpSync(NEUTRAL_SPECIMENS_SRC, contractDir, { recursive: true });
  process.env['FORGE_READABILITY_DIR'] = contractDir;
  resetReadabilityContractForTests();
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env['FORGE_READABILITY_DIR'];
  else process.env['FORGE_READABILITY_DIR'] = originalEnv;
  resetReadabilityContractForTests();
  rmSync(contractDir, { recursive: true, force: true });
});

/** Rewrites one prose ceiling in the copied contract and clears the load cache. */
function setCeiling(surface: string, value: number): void {
  const file = path.join(contractDir, 'contract.json');
  const contract = JSON.parse(readFileSync(file, 'utf8'));
  contract.prose_ceiling_words[surface] = value;
  writeFileSync(file, JSON.stringify(contract, null, 2), 'utf8');
  resetReadabilityContractForTests();
}

describe('checkOutwardDraft -- every refusal reported before any write', () => {
  it('reports all three refusals in one pass, naming the ceiling and the count for each', () => {
    const report = checkOutwardDraft(
      {
        repo: 'acme-app',
        diffStats: THREE_PRODUCTION_FILES,
        texts: {
          'commit-message': 'ACME-1 Stop the sheet dismissing itself',
          'pr-title': 'ACME-1 Stop the sheet dismissing itself',
          'pr-body': prBody174(),
          'jira-comment': words(157),
        },
      },
      AS_OF,
    );

    const denials = report.findings.filter((f) => f.verdict === 'DENY');

    const body = denials.filter((f) => f.surface === 'pr-body');
    expect(body).toHaveLength(1);
    expect(body[0]!.reason).toContain('174 words of prose, over the 150-word ceiling');
    expect(body[0]!.reason).toContain('src/three.ts');

    const comment = denials.filter((f) => f.surface === 'jira-comment');
    expect(comment).toHaveLength(1);
    expect(comment[0]!.reason).toContain('157 words of prose, over the 80-word ceiling');

    // One pass, not three attempts: every refused surface is in the same report.
    expect(new Set(denials.map((f) => f.surface))).toEqual(new Set(['pr-body', 'jira-comment']));
  });

  it('reports nothing on a draft that fits', () => {
    const report = checkOutwardDraft(
      {
        repo: 'acme-app',
        diffStats: THREE_PRODUCTION_FILES,
        texts: {
          'commit-message': 'ACME-1 Stop the sheet dismissing itself',
          'pr-title': 'ACME-1 Stop the sheet dismissing itself',
          'pr-body': prBodyThatFits(),
          'jira-comment': words(20),
        },
      },
      AS_OF,
    );
    expect(report.findings).toEqual([]);
  });

  it('reads the ceiling from the contract file, so a contract change moves the reported number', () => {
    const draft = {
      repo: 'acme-app',
      diffStats: THREE_PRODUCTION_FILES,
      texts: { 'jira-comment': words(157) },
    };

    const before = checkOutwardDraft(draft, AS_OF).findings;
    expect(before[0]!.reason).toContain('over the 80-word ceiling');

    setCeiling('jira-comment', 200);
    expect(checkOutwardDraft(draft, AS_OF).findings).toEqual([]);

    setCeiling('jira-comment', 40);
    const after = checkOutwardDraft(draft, AS_OF).findings;
    expect(after[0]!.reason).toContain('over the 40-word ceiling');
  });

  it('refuses a machine authorship claim in the commit message before the commit is attempted', () => {
    const report = checkOutwardDraft(
      {
        repo: 'acme-app',
        texts: { 'commit-message': `ACME-1 Fix the sheet\n\n${ATTRIBUTION_TRAILER} <someone@example.com>` },
      },
      AS_OF,
    );
    const hit = report.findings.find((f) => f.surface === 'commit-message');
    expect(hit?.verdict).toBe('DENY');
    expect(hit?.reason.toLowerCase()).toContain('authorship');
  });

  it('names every in-scope surface as one humanizer pass rather than one per write', () => {
    const report = checkOutwardDraft(
      {
        repo: 'acme-app',
        texts: {
          'commit-message': 'ACME-1 Fix the sheet',
          'pr-body': prBodyThatFits(),
          'jira-comment': words(20),
        },
      },
      AS_OF,
    );
    expect(new Set(report.humanize)).toEqual(new Set(['commit-message', 'pr-body', 'jira-comment']));
  });

  it('leaves a repo that is not outward-facing alone, but still checks the issue surfaces', () => {
    const report = checkOutwardDraft(
      {
        repo: 'internal-tooling',
        texts: { 'pr-body': prBody174(), 'jira-comment': words(157) },
      },
      AS_OF,
    );
    expect(report.findings.map((f) => f.surface)).toEqual(['jira-comment']);
    expect(report.humanize).toEqual(['jira-comment']);
  });

  it('formats a report a person can act on, one line per refusal', () => {
    const report = checkOutwardDraft(
      {
        repo: 'acme-app',
        diffStats: THREE_PRODUCTION_FILES,
        texts: { 'pr-body': prBody174(), 'jira-comment': words(157) },
      },
      AS_OF,
    );
    const text = formatDraftReport(report);
    expect(text).toContain('pr-body');
    expect(text).toContain('jira-comment');
    expect(text).toContain('174');
    expect(text).toContain('157');
    expect(formatDraftReport({ findings: [], humanize: [] })).toContain('no refusal');
  });
});

describe('forge draft -- the one step a person runs before writing anything', () => {
  it('exits 1 and lists every refused surface, exits 0 on a draft that fits', async () => {
    const { forge } = await import('../../../src/forge/cli.ts');
    const file = path.join(contractDir, 'draft.json');

    writeFileSync(file, JSON.stringify({
      repo: 'acme-app',
      diffStats: THREE_PRODUCTION_FILES,
      texts: { 'pr-body': prBody174(), 'jira-comment': words(157) },
    }), 'utf8');
    const refused = await forge(['draft', file]);
    expect(refused.code).toBe(1);
    expect(refused.lines.join('\n')).toContain('174 words of prose');
    expect(refused.lines.join('\n')).toContain('157 words of prose');

    writeFileSync(file, JSON.stringify({
      repo: 'acme-app',
      diffStats: THREE_PRODUCTION_FILES,
      texts: { 'pr-body': prBodyThatFits(), 'jira-comment': words(20) },
    }), 'utf8');
    const fits = await forge(['draft', file]);
    expect(fits.code).toBe(0);
    expect(fits.lines.join('\n')).toContain('no refusal');
  });

  it('refuses a missing or malformed draft file with exit 2 rather than a crash', async () => {
    const { forge } = await import('../../../src/forge/cli.ts');
    expect((await forge(['draft'])).code).toBe(2);
    expect((await forge(['draft', path.join(contractDir, 'nope.json')])).code).toBe(2);
    const bad = path.join(contractDir, 'bad.json');
    writeFileSync(bad, '{ not json', 'utf8');
    expect((await forge(['draft', bad])).code).toBe(2);
    const noTexts = path.join(contractDir, 'notexts.json');
    writeFileSync(noTexts, JSON.stringify({ repo: 'acme-app' }), 'utf8');
    expect((await forge(['draft', noTexts])).code).toBe(2);
  });
});
