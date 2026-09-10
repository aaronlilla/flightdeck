/**
 * Joins the whole-machine session registry to the real process table for the Machine
 * page (goal `machine-window`, R-59): every live session's own process subtree, plus
 * every `claude`/`codex`/`node`/`python` process root nothing here recognizes as a
 * session's own. Pure and synchronous -- the route (`server.ts`) is the only caller that
 * ever hands it a real process table; every other caller is a test fixture.
 *
 * Descendant walking is `sweep.ts`'s own `descendantsOf`, imported rather than
 * reimplemented (order 6: two independent trees of the same process table are exactly
 * the kind of drift a second implementation would eventually earn).
 */
import { descendantsOf, type ProcessRow } from '../sweep.js';
import { maskCommandLine } from './redact.js';

/** A root process name this join treats as worth surfacing when no session claims it.
 *  Anything else left over (a stray `explorer.exe`, a shell) is machine noise the page
 *  has no use naming. */
const ROOT_NAME_PATTERN = /claude|codex|node|python/i;

/** Measured 2026-09-10 (`scripts/tmp-measure-process-table.ts`, goal `machine-window`
 *  Status section): `realProcessTable()`'s median was 991 ms on this machine, over the
 *  500 ms threshold, so the plain 5 s tick would spend ~20% of its own interval just
 *  reading. 10 s keeps the read at 9.91% duty. */
export const MACHINE_READ_INTERVAL_MS = 10_000;

/** How long a command line renders outside `?verbose=1`, both server-side
 *  (`server.ts`'s `machineNodeForDisplay`, the default JSON register) and client-side
 *  (`MachineView.tsx`'s own re-truncation of whatever fixture or response it is handed).
 *  One shared constant so the two can never drift apart (`/code-review high`,
 *  2026-09-10: they were two separately hardcoded `80`s). */
export const MACHINE_COMMAND_LINE_GLANCE_LENGTH = 80;

export interface MachineSessionInput {
  sessionId: string;
  /** `undefined`, or a pid the process table no longer carries, both mean "dead": the
   *  session gets a card with no subtree, never an error. */
  pid?: number;
  name?: string;
  repo?: string | null;
  branch?: string | null;
  status?: string;
  startedAt?: number;
}

export interface MachineProcessNode {
  pid: number;
  ppid: number;
  name: string;
  ageMs: number;
  commandLine: string;
  output: 'not captured';
  children: MachineProcessNode[];
}

export interface MachineSessionEntry {
  sessionId: string;
  pid?: number;
  name?: string;
  repo: string | null;
  branch: string | null;
  status: string;
  startedAt?: number;
  /** `null` for a dead session pid -- no subtree, never a fabricated one. */
  root: MachineProcessNode | null;
}

export interface MachineSnapshot {
  readAt: number;
  readMs: number;
  intervalMs: number;
  sessions: MachineSessionEntry[];
  unregistered: MachineProcessNode[];
  counts: { sessions: number; processes: number; unregistered: number };
}

function toNode(row: ProcessRow): MachineProcessNode {
  return {
    pid: row.pid,
    ppid: row.ppid,
    name: row.name,
    ageMs: row.ageMs,
    commandLine: maskCommandLine(row.commandLine ?? ''),
    output: 'not captured',
    children: [],
  };
}

/** Nests a flat, already-closed set of rows (a root plus `descendantsOf(root.pid, ...)`,
 *  never a fresh walk of the whole table) into a tree by grouping on `ppid`. The
 *  set is closed and finite by construction, so this needs none of `descendantsOf`'s
 *  own cycle guard -- that discovery already happened before this is called. */
function nest(rootPid: number, pool: ProcessRow[]): MachineProcessNode {
  const byPid = new Map(pool.map((row) => [row.pid, row]));
  const childrenOfPid = new Map<number, ProcessRow[]>();
  for (const row of pool) {
    if (row.pid === rootPid) continue;
    const list = childrenOfPid.get(row.ppid) ?? [];
    list.push(row);
    childrenOfPid.set(row.ppid, list);
  }
  // Belt and suspenders against a malformed table (a `ppid` cycle among two or more
  // rows in the pool): `descendantsOf`'s own `seen` guard protects discovery, but this
  // is a second, independent walk over the same rows, so it earns its own guard rather
  // than trusting "closed and finite by construction" against input it never checks
  // (`/critique`, 2026-09-10). A child already on the current ancestor chain is dropped
  // rather than recursed into again.
  const build = (pid: number, ancestors: ReadonlySet<number>): MachineProcessNode => {
    const row = byPid.get(pid) as ProcessRow;
    const node = toNode(row);
    const withSelf = new Set(ancestors).add(pid);
    node.children = (childrenOfPid.get(pid) ?? [])
      .filter((child) => !withSelf.has(child.pid))
      .map((child) => build(child.pid, withSelf));
    return node;
  };
  return build(rootPid, new Set());
}

export function buildMachineSnapshot(
  sessions: MachineSessionInput[],
  rows: ProcessRow[],
  now: number,
  opts: { intervalMs?: number; readMs?: number } = {},
): MachineSnapshot {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const covered = new Set<number>();
  let processCount = 0;

  const sessionEntries: MachineSessionEntry[] = sessions.map((session) => {
    const selfRow = session.pid !== undefined ? byPid.get(session.pid) : undefined;
    let root: MachineProcessNode | null = null;
    if (selfRow) {
      const descendants = descendantsOf(selfRow.pid, rows);
      const pool = [selfRow, ...descendants];
      root = nest(selfRow.pid, pool);
      // `covered` is a Set, so a pid two stale session records share (a real Windows
      // pid-reuse race) is only ever counted once here, never once per session that
      // claims it (`/critique`, 2026-09-10).
      for (const row of pool) {
        if (!covered.has(row.pid)) processCount += 1;
        covered.add(row.pid);
      }
    }
    return {
      sessionId: session.sessionId,
      pid: session.pid,
      name: session.name,
      repo: session.repo ?? null,
      branch: session.branch ?? null,
      status: session.status ?? 'unknown',
      startedAt: session.startedAt,
      root,
    };
  });

  const remaining = rows.filter((row) => !covered.has(row.pid));
  const remainingByPid = new Map(remaining.map((row) => [row.pid, row]));
  const consumedByUnregistered = new Set<number>();
  const unregistered: MachineProcessNode[] = [];

  // A row belongs to an ancestor's subtree, not a root of its own, only when that
  // ancestor ALSO matches `ROOT_NAME_PATTERN` -- walking past any number of
  // non-matching processes in between (a `powershell.exe` or `cmd.exe` launcher, say).
  // The earlier cut skipped a row for having ANY parent still in `remaining`, which
  // meant a `claude`/`codex`/`node`/`python` process under a non-matching parent could
  // never become a root and vanished from the page entirely (`/code-review high`,
  // 2026-09-10). A cycle (including a self-referencing `ppid`) has no such ancestor to
  // find and terminates via `seen`, so it still resolves to "no matching ancestor" --
  // that residual case (an all-matching-name cycle drops out of the snapshot rather
  // than crashing) is accepted, see this file's `/critique` Status entry.
  function hasMatchingAncestor(row: ProcessRow): boolean {
    const seen = new Set<number>([row.pid]);
    let current = row;
    for (;;) {
      const parent = remainingByPid.get(current.ppid);
      if (!parent || seen.has(parent.pid)) return false;
      if (ROOT_NAME_PATTERN.test(parent.name)) return true;
      seen.add(parent.pid);
      current = parent;
    }
  }

  for (const row of remaining) {
    if (consumedByUnregistered.has(row.pid)) continue;
    if (!ROOT_NAME_PATTERN.test(row.name)) continue;
    if (hasMatchingAncestor(row)) continue;
    const descendants = descendantsOf(row.pid, remaining);
    const pool = [row, ...descendants];
    const node = nest(row.pid, pool);
    for (const member of pool) consumedByUnregistered.add(member.pid);
    unregistered.push(node);
  }

  return {
    readAt: now,
    readMs: opts.readMs ?? 0,
    intervalMs: opts.intervalMs ?? MACHINE_READ_INTERVAL_MS,
    sessions: sessionEntries,
    unregistered,
    counts: {
      sessions: sessionEntries.length,
      processes: processCount + consumedByUnregistered.size,
      unregistered: consumedByUnregistered.size,
    },
  };
}

export { descendantsOf };
