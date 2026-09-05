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

  it('code-review finding: never moves conductor_hooks.py or the model policy, even though OLD_RUNTIME matches them', () => {
    // The falsifier this closes: a broadened manifest (B.3.9's own fix, above) that
    // matches more than the fixed four also has to keep excluding NEVER_REMOVE, or the
    // widening reintroduces exactly the guard-removed-mid-flight failure NEVER_REMOVE
    // exists to prevent.
    writeFileSync(join(from, 'conductor_hooks.py'), '# hooks\n', 'utf8');
    writeFileSync(join(from, 'model-policy.json'), '{}', 'utf8');
    const result = runCutover({ from, retiredDir, processList: [] }, journal);
    expect(result.moved).not.toContain('conductor_hooks.py');
    expect(result.moved).not.toContain('model-policy.json');
    expect(existsSync(join(from, 'conductor_hooks.py'))).toBe(true);
    expect(existsSync(join(from, 'model-policy.json'))).toBe(true);
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

/**
 * F4: the process check only knew the warden.
 *
 * On 2026-09-05 at 01:02 the cutover reported no live process and completed while
 * `tile.ps1 -Watch -Gap 4 -Every 4` (the retired grid's window tiler, itself one of the
 * files a cutover moves) was still running as pid 17728, and had to be stopped by hand
 * afterward. The refusal has to cover any process naming a manifest file, not only the
 * warden line.
 */
describe('F4: a running manifest file refuses the cutover, warden or no warden', () => {
  it('refuses and names the pid and the file when a manifest file is still running', () => {
    const result = runCutover({
      from, retiredDir,
      processList: ['17728 "powershell.exe" -File tile.ps1 -Watch -Gap 4 -Every 4'],
    }, journal);
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/tile\.ps1/);
    expect(result.refusal).toMatch(/17728/);
    for (const name of CUTOVER_FILES) expect(existsSync(join(from, name))).toBe(true);
  });

  it('never runs the move when it refuses on a manifest file', () => {
    runCutover({
      from, retiredDir,
      processList: ['17728 "powershell.exe" -File tile.ps1 -Watch'],
    }, journal);
    expect(journaled).toHaveLength(0);
  });

  it('proceeds when the process list names neither the warden nor a manifest file', () => {
    const result = runCutover({
      from, retiredDir,
      processList: ['1000 node some-unrelated-daemon.js'],
    }, journal);
    expect(result.ok).toBe(true);
    expect(result.moved).toHaveLength(CUTOVER_FILES.length);
  });

  it('cutover.completed carries the count of processes checked', () => {
    const processList = ['1000 node some-unrelated-daemon.js', '1001 node another.js'];
    runCutover({ from, retiredDir, processList }, journal);
    const event = journaled.find((e) => e['event'] === 'cutover.completed');
    expect(event?.['processesChecked']).toBe(processList.length);
  });

  /**
   * A short manifest name (`go.py`) is a substring of an unrelated process's own name
   * (`mongo.py`, `cargo.py`), so a plain `line.includes(name)` refused a cutover over a
   * process that had nothing to do with it. The name has to appear as its own token.
   */
  it('a short manifest name inside an unrelated process name never refuses', () => {
    writeFileSync(join(from, 'go.py'), '# go.py\n', 'utf8');
    const result = runCutover({
      from, retiredDir,
      processList: ['5000 "C:\\tools\\mongo.py" --port 27017'],
    }, journal);
    expect(result.ok).toBe(true);
    expect(result.moved).toContain('go.py');
  });

  it('the same manifest name as its own token still refuses', () => {
    writeFileSync(join(from, 'go.py'), '# go.py\n', 'utf8');
    const result = runCutover({
      from, retiredDir,
      processList: ['5001 "C:\\tools\\go.py" --warden'],
    }, journal);
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/go\.py/);
    expect(result.refusal).toMatch(/5001/);
  });
});
