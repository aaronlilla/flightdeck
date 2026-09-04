/**
 * Retiring the old spawn path.
 *
 * Everything here runs on a temp directory with fake files and an injected process list;
 * nothing touches the real coordination directory or the real process table.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { CUTOVER_FILES, runCutover } from '../../src/forge/cutover.js';

let from: string;
let retiredDir: string;
let journaled: Record<string, unknown>[];
const journal = { append: (event: Record<string, unknown>) => journaled.push(event) };

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'forge-cutover-'));
  from = join(root, 'coordination');
  retiredDir = join(root, 'retired', '2026-09-04');
  mkdirSync(from, { recursive: true });
  journaled = [];
  for (const name of CUTOVER_FILES) writeFileSync(join(from, name), `# ${name}\n`, 'utf8');
});

describe('a clean cutover', () => {
  it('moves all four files out of the source directory', () => {
    const result = runCutover({ from, retiredDir, processList: [] }, journal);
    expect(result.ok).toBe(true);
    expect(result.moved.sort()).toEqual([...CUTOVER_FILES].sort());
  });

  it('removes the source files rather than copying them', () => {
    runCutover({ from, retiredDir, processList: [] }, journal);
    for (const name of CUTOVER_FILES) {
      expect(existsSync(join(from, name))).toBe(false);
    }
  });

  it('leaves every file readable at the retired path', () => {
    runCutover({ from, retiredDir, processList: [] }, journal);
    for (const name of CUTOVER_FILES) {
      expect(existsSync(join(retiredDir, name))).toBe(true);
    }
  });

  it('journals cutover.completed naming every file it moved', () => {
    runCutover({ from, retiredDir, processList: [] }, journal);
    const event = journaled.find((e) => e['event'] === 'cutover.completed');
    expect(event).toBeTruthy();
    expect((event?.['files'] as string[]).sort()).toEqual([...CUTOVER_FILES].sort());
  });

  it('skips a file that is already gone rather than failing', () => {
    rmSync(join(from, 'terminals.py'));
    const result = runCutover({ from, retiredDir, processList: [] }, journal);
    expect(result.ok).toBe(true);
    expect(result.moved).not.toContain('terminals.py');
    expect(result.moved).toHaveLength(3);
  });

  it('journals one cutover.moved row per file, before cutover.completed', () => {
    runCutover({ from, retiredDir, processList: [] }, journal);
    const movedEvents = journaled.filter((e) => e['event'] === 'cutover.moved');
    expect(movedEvents.map((e) => e['file']).sort()).toEqual([...CUTOVER_FILES].sort());
    const completedIndex = journaled.findIndex((e) => e['event'] === 'cutover.completed');
    expect(completedIndex).toBe(journaled.length - 1);
    expect(journaled.slice(0, completedIndex).every((e) => e['event'] === 'cutover.moved')).toBe(true);
  });

  it('B.3.9: a file absent before the cutover starts is simply not in the manifest at all', () => {
    // The manifest is now scanned from what is actually present (filesMatching), not
    // compared against a fixed expected list, so there is no "missing" to report: a file
    // that was never there was never part of this cutover's work.
    rmSync(join(from, 'terminals.py'));
    runCutover({ from, retiredDir, processList: [] }, journal);
    const event = journaled.find((e) => e['event'] === 'cutover.completed');
    expect((event?.['files'] as string[]).sort()).toEqual(
      CUTOVER_FILES.filter((name) => name !== 'terminals.py').sort(),
    );
    expect(event?.['missing']).toBeUndefined();
  });

  it('B.3.9: the manifest is derived from install.ts\'s detection list, not a hardcoded four', () => {
    // A fifth file the fixed CUTOVER_FILES array never named, but which install.ts's own
    // OLD_RUNTIME patterns match (a second tile script): if the manifest were still the
    // hardcoded four, this would be left behind.
    writeFileSync(join(from, 'tile-watch-2.cmd'), '# extra\n', 'utf8');
    const result = runCutover({ from, retiredDir, processList: [] }, journal);
    expect(result.moved).toContain('tile-watch-2.cmd');
    expect(existsSync(join(retiredDir, 'tile-watch-2.cmd'))).toBe(true);
  });
});

describe('an empty source directory', () => {
  it('refuses rather than reporting cutover.completed over a no-op', () => {
    for (const name of CUTOVER_FILES) rmSync(join(from, name));
    const result = runCutover({ from, retiredDir, processList: [] }, journal);
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/no.*file|nothing/i);
    expect(journaled.some((e) => e['event'] === 'cutover.completed')).toBe(false);
  });
});

describe('the warden refusal', () => {
  it('refuses when the process list holds a conductor warden line', () => {
    const result = runCutover({
      from, retiredDir,
      processList: ['1234 python conductor.py warden --home /coordination'],
    }, journal);
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/warden/i);
    for (const name of CUTOVER_FILES) expect(existsSync(join(from, name))).toBe(true);
  });

  it('never runs the move when it refuses', () => {
    runCutover({
      from, retiredDir, processList: ['1234 python conductor.py warden'],
    }, journal);
    expect(journaled).toHaveLength(0);
  });

  /**
   * The falsifier: a process list with `conductor.py` in a non-warden role, sitting
   * alongside an unrelated line, must not trip the refusal. Matching on `conductor.py`
   * alone would block every cutover on a process that was never the warden.
   */
  it('does not refuse on a conductor.py line that is not the warden', () => {
    const result = runCutover({
      from, retiredDir,
      processList: [
        '999 python conductor.py --role hooks-install',
        '1000 node some-unrelated-daemon.js',
      ],
    }, journal);
    expect(result.ok).toBe(true);
    expect(result.moved).toHaveLength(CUTOVER_FILES.length);
  });
});
