/**
 * Item 4 of the ticket-friction goal: nothing told a worker that an emulator cannot see a
 * bottom-chrome bug. The tester had to write it into the ticket by hand, after measuring
 * 23px of a button exposed on the emulator against 0px on a phone.
 *
 * The assertion that matters is NOT that the routine file exists -- reading the file back
 * proves nothing about what a worker is handed. Every test below reads the brief that
 * `queuePlanner` wrote to disk, through the same function the real wiring calls, and
 * checks the routine is IN it.
 *
 * It was not, before this. `queuePlanner` never passed a `repoKind` to its own
 * `writeBrief`, so a routine tagged `frontend` could not match any brief it ever wrote.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { queuePlanner } from '../../../src/forge/queue-wire.ts';
import { readChainEnv } from '../../../src/forge/chain-env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROUTINES = path.join(__dirname, '..', '..', '..', 'routines');

const ROUTINE_MARK = 'An emulator cannot see a bottom-chrome bug';

let home: string;
const saved: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'forge-routines-brief-'));
  setEnv('FORGE_HOME', home);
  setEnv('FORGE_ROUTINES_DIR', REPO_ROUTINES);
  // Two repos, one declared frontend and one declared backend, so the routine's own tag
  // is what decides -- not the repository's name, which this fleet never reads.
  setEnv('FORGE_REPO_KIND', 'acme/acme-app=frontend,acme/acme-api=backend');
  setEnv('FORGE_INTAKE_REPO_MAP', '');
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

/** Writes a brief through the real planner and hands back what landed on disk. */
async function briefFor(text: string): Promise<string> {
  const planner = queuePlanner(() => undefined, readChainEnv());
  const planned = await planner.planBrief(text);
  return readFileSync(planned.briefPath, 'utf8');
}

describe('the brief a mobile worker is handed', () => {
  it('carries the device routine, read back off the file the planner wrote', async () => {
    const brief = await briefFor('repo: acme/acme-app\n\nMove the button above the tab bar.');
    expect(brief).toContain(ROUTINE_MARK);
    expect(brief).toContain('23px');
  });

  it('carries it even when the brief says nothing a routine tag would match', async () => {
    // The brief's own words match no tag here; the repository's declared kind is what
    // brings the routine in. A worker must never lose the device rule by wording a brief
    // differently.
    const brief = await briefFor('repo: acme/acme-app\n\nRename a variable.');
    expect(brief).toContain(ROUTINE_MARK);
  });

  it('still carries the general routines when nothing else matches', async () => {
    const brief = await briefFor('repo: acme/acme-api\n\nRename a variable.');
    expect(brief).toContain('## Routines');
  });

  // The edge case that keeps this honest: a backend brief must NOT carry it. A rule that
  // reaches every brief is a rule nobody reads.
  it('does not put the device routine in a backend brief', async () => {
    const brief = await briefFor('repo: acme/acme-api\n\nAdd a column to the ledger table.');
    expect(brief).not.toContain(ROUTINE_MARK);
  });

  it('reaches a hotfix brief on a mobile repo too', async () => {
    const planner = queuePlanner(() => undefined, readChainEnv());
    const planned = await planner.planHotfix!('repo: acme/acme-app\n\nThe footer is under the bar.');
    expect(readFileSync(planned.briefPath, 'utf8')).toContain(ROUTINE_MARK);
  });
});

describe('the routine file itself', () => {
  it('is tagged so a mobile brief can match it, and says what an emulator cannot see', () => {
    const file = path.join(REPO_ROUTINES, 'bottom-chrome-needs-a-real-device.md');
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/tags:\s*\[[^\]]*\bfrontend\b/);
    expect(text).toContain(ROUTINE_MARK);
    // The rule that stops the same defect being written into a test: assert movement,
    // never a fixed number.
    expect(text.toLowerCase()).toContain('moves when the inset moves');
  });

  it('is not silently dropped when the routines directory is empty', async () => {
    const empty = path.join(home, 'no-routines');
    mkdirSync(empty, { recursive: true });
    writeFileSync(path.join(empty, 'placeholder.txt'), 'not a routine', 'utf8');
    setEnv('FORGE_ROUTINES_DIR', empty);
    const brief = await briefFor('repo: acme/acme-app\n\nMove the button above the tab bar.');
    expect(brief).not.toContain('## Routines');
  });
});
