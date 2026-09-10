/**
 * Nothing cleans up what a dead run leaves running: a hung `npm test` or a stray
 * `node.exe` outlives the worker that started it. This walks the real process table
 * (`Win32_Process`, injected as `processes` so a test never shells out) to find every
 * transitive descendant of a run's worker pid, and kills the ones old enough to be
 * orphans -- but never anything whose own ancestor chain touches the live console pid
 * or a live session pid, even a few levels up. `taskkill /T` is deliberately never used
 * here: it takes the whole tree from wherever it is pointed, which is exactly how the
 * console lost 161 processes to one command on 2026-09-08 (`forge-console-launch-and-
 * single-ticker`). Each pid this module kills is targeted individually.
 */
export interface ProcessRow {
  pid: number;
  ppid: number;
  name: string;
  /** Milliseconds since this process started, supplied by the caller (real code reads
   *  `Win32_Process.CreationDate`; a test hands the age directly). */
  ageMs: number;
}

export interface SweepJournal {
  append(event: Record<string, unknown>): unknown;
}

export interface SweepInput {
  processes: ProcessRow[];
  journal: SweepJournal;
  /** Kills exactly this one pid -- never a tree, never `/T`. */
  kill: (pid: number) => void;
  /** The worker pid of the run that just finished, was killed, or vanished. */
  finishedRunPid: number;
  /** The live console's own pid -- never touched, however it is reached. */
  consolePid: number;
  /** Every other currently-live run/session pid -- also never touched. */
  liveSessionPids: number[];
  /** How old a leftover process must be before it counts as an orphan. Default 60s. */
  minAgeMs?: number;
}

function childrenOf(pid: number, rows: ProcessRow[]): ProcessRow[] {
  return rows.filter((row) => row.ppid === pid);
}

/** Every process transitively spawned by `pid`, found by walking the children relation
 *  down (never by assuming the process table names an ancestor chain honestly upward,
 *  which pid reuse could spoof). A process not reachable this way is not in the
 *  finished run's subtree, full stop -- this is the boundary the guardrail names. */
function descendantsOf(pid: number, rows: ProcessRow[]): ProcessRow[] {
  const out: ProcessRow[] = [];
  const seen = new Set<number>();
  const stack = [...childrenOf(pid, rows)];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next || seen.has(next.pid)) continue;
    seen.add(next.pid);
    out.push(next);
    stack.push(...childrenOf(next.pid, rows));
  }
  return out;
}

/** Every ancestor pid of `pid`, walking `ppid` up as far as (but not including)
 *  `boundaryPid` -- the finished run's own worker pid, which is always an ancestor of
 *  everything in its own subtree and must never itself disqualify a kill. Bounded this
 *  way, this is a second, independent check before any kill: belt and suspenders against
 *  a pid recycled by a live session or the console somewhere between the candidate and
 *  the run boundary. Checking only the *direct* parent here is exactly the bug the
 *  console-pid-as-grandparent specimen catches -- the walk has to go all the way up to
 *  the boundary, not stop one hop in. */
function ancestorsUntil(pid: number, boundaryPid: number, rows: ProcessRow[]): number[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const chain: number[] = [];
  const seen = new Set<number>([pid]);
  let current = byPid.get(pid);
  while (current && current.ppid && current.ppid !== boundaryPid && !seen.has(current.ppid)) {
    seen.add(current.ppid);
    chain.push(current.ppid);
    current = byPid.get(current.ppid);
  }
  return chain;
}

/** Sweeps one finished run's leftover process tree. Safe to call once per `run.finished`
 *  / `run.killed` / `session.vanished` row -- it only ever looks at, and only ever kills,
 *  processes that are both (a) a transitive child of `finishedRunPid` and (b) never
 *  ancestored, at any depth, by the live console pid or a live session pid. */
export function sweepFinishedRun(input: SweepInput): void {
  const minAgeMs = input.minAgeMs ?? 60_000;
  const protectedPids = new Set([input.consolePid, ...input.liveSessionPids]);
  if (protectedPids.has(input.finishedRunPid)) return; // never sweep a still-live run
  const candidates = descendantsOf(input.finishedRunPid, input.processes);
  for (const proc of candidates) {
    if (proc.ageMs < minAgeMs) continue;
    if (protectedPids.has(proc.pid)) continue;
    const ancestors = ancestorsUntil(proc.pid, input.finishedRunPid, input.processes);
    if (ancestors.some((pid) => protectedPids.has(pid))) continue;
    input.journal.append({ event: 'orphan.found', name: proc.name, pid: proc.pid, ageMs: proc.ageMs });
    input.kill(proc.pid);
  }
}
