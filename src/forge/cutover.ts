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

export interface CutoverJournal {
  append(event: Record<string, unknown>): unknown;
}

/** The four files a cutover retires, named rather than matched, so nothing else is swept up. */
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
 * Move the four old spawn files aside, or refuse.
 *
 * Refuses rather than moving nothing: a cutover that silently skipped every file because
 * the warden check passed by accident would report success over a no-op.
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

  mkdirSync(request.retiredDir, { recursive: true });
  const moved: string[] = [];
  for (const name of CUTOVER_FILES) {
    const source = join(request.from, name);
    if (!existsSync(source)) continue;
    renameSync(source, join(request.retiredDir, name));
    moved.push(name);
  }

  journal.append({ event: 'cutover.completed', actor: 'runner', files: moved });
  return { ok: true, moved };
}
