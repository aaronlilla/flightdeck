/**
 * Retiring the old spawn path, once the new one is proven.
 *
 * `install.ts` already surveys what the old conductor left behind and writes a plan for
 * Stage C. This is the command that plan becomes: move the four files that started the
 * old dashboard out of the coordination directory and into a dated retired folder, and
 * refuse outright if a conductor warden process is still watching. `conductor.py` alone is
 * not enough to refuse on — the old runtime ran other roles under that same script, and a
 * refusal that matches on the module name alone would block a cutover on a process that
 * was never the warden.
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { filesMatching, isNeverRemove } from './install.js';

export interface CutoverJournal {
  append(event: Record<string, unknown>): unknown;
}

/**
 * The exact four names a cutover used to retire, before this manifest was derived from
 * install.ts's own detection list (`OLD_RUNTIME`, install.ts:41-46) instead of being
 * hardcoded here. Kept as a reference for what the fixed list used to be; no longer read
 * by `runCutover`, which now calls `filesMatching()` so a real coordination directory
 * holding more than these four (a second `conductor_*.py`, a `tile-watch-2.cmd`) is
 * still retired in full rather than leaving strays behind.
 */
export const CUTOVER_FILES = ['tile-watch.vbs', 'tile-watch.cmd', 'tile.ps1', 'terminals.py'];

export interface CutoverRequest {
  /** The coordination directory the old runtime's files live in. */
  from: string;
  /** Where retired files land. Callers pass a dated path; nothing here invents one. */
  retiredDir: string;
  /** The live process table, one line per process. Injected, never read from this machine. */
  processList: string[];
}

export interface CutoverResult {
  ok: boolean;
  refusal?: string;
  moved: string[];
}

/**
 * A conductor warden line: both `conductor.py` and `warden` on the same line.
 *
 * `conductor.py` ran other roles too, so that name alone is not proof anything is still
 * watching. A specimen without `warden` on the line has to pass this check for the
 * refusal to mean what it says.
 */
function findWardenLine(processList: string[]): string | undefined {
  return processList.find((line) => /conductor\.py/i.test(line) && /warden/i.test(line));
}

/**
 * F4: a process still running one of the manifest's own files, whether or not it is
 * the warden.
 *
 * On 2026-09-05 the cutover found no `conductor.py ... warden` line and completed, while
 * `tile.ps1 -Watch -Gap 4 -Every 4` (the retired grid's window tiler, itself one of the
 * files this cutover moves) was still running as pid 17728 and had to be killed by hand
 * afterwards. The warden check alone only ever covered the one process that spawns the
 * others; this covers every process naming a file the manifest is about to move, the
 * tiler included.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A manifest name as its own token on a process line, not a substring of a longer one.
 *
 * `line.includes(name)` matched `go.py` inside `mongo.py` and `cargo.py` -- a real
 * process nowhere near the manifest, refusing a cutover it had nothing to do with. The
 * name has to be preceded by the start of the line, whitespace, a quote or a path
 * separator, and followed by the end of the line, whitespace or a quote.
 */
function containsManifestName(line: string, name: string): boolean {
  const boundary = new RegExp(`(?:^|[\\s"'/\\\\])${escapeRegExp(name)}(?:$|[\\s"'])`);
  return boundary.test(line);
}

function findManifestProcessLine(
  processList: string[], manifest: string[],
): { line: string; file: string; pid?: string } | undefined {
  for (const line of processList) {
    const file = manifest.find((name) => containsManifestName(line, name));
    if (file) return { line, file, pid: /^\s*(\d+)/.exec(line)?.[1] };
  }
  return undefined;
}

/**
 * Move the four old spawn files aside, or refuse.
 *
 * Refuses rather than moving nothing: a `--from` directory holding none of the four
 * files (already retired, or never the right directory) used to still journal
 * `cutover.completed`, which is how a no-op looked exactly like a real run.
 */
export function runCutover(request: CutoverRequest, journal: CutoverJournal): CutoverResult {
  const wardenLine = findWardenLine(request.processList);
  if (wardenLine) {
    return {
      ok: false,
      refusal: `a conductor warden process is live (${wardenLine.trim()}); stop it before `
        + 'retiring the files it still spawns from',
      moved: [],
    };
  }

  // NEVER_REMOVE filtered out here, the same way planUninstall filters it out of what it
  // proposes: filesMatching reports everything present, informationally, and a caller
  // that acts on the result is the one that must never touch a guard or the model policy.
  const manifest = filesMatching(request.from).filter((name) => !isNeverRemove(name));
  if (manifest.length === 0) {
    return {
      ok: false,
      refusal: `none of install.ts's old-runtime files were found under ${request.from}; `
        + 'nothing to move',
      moved: [],
    };
  }

  // F4: a manifest file still running -- the retired grid's window tiler, say -- has to
  // be stopped before it can be moved out from under itself, warden or no warden.
  const manifestLine = findManifestProcessLine(request.processList, manifest);
  if (manifestLine) {
    return {
      ok: false,
      refusal: `${manifestLine.file} is still running`
        + `${manifestLine.pid ? ` (pid ${manifestLine.pid})` : ''}: `
        + `${manifestLine.line.trim()}; stop it before retiring the files it spawns from`,
      moved: [],
    };
  }

  mkdirSync(request.retiredDir, { recursive: true });
  const moved: string[] = [];
  for (const name of manifest) {
    const source = join(request.from, name);
    if (!existsSync(source)) continue;
    renameSync(source, join(request.retiredDir, name));
    moved.push(name);
    // One row per file, before the next rename: a crash partway through a multi-file
    // cutover leaves a record of exactly which files already moved, not just a summary
    // that never got written.
    journal.append({ event: 'cutover.moved', actor: 'runner', file: name });
  }

  journal.append({
    event: 'cutover.completed', actor: 'runner', files: moved,
    processesChecked: request.processList.length,
  });
  return { ok: true, moved };
}
