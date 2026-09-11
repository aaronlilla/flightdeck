/**
 * What the registry tick should journal, as a pure decision over (what the process table
 * says) x (what the journal fold currently believes). Pulled out of `cli.ts`'s tick so the
 * rule itself can be driven by a test; the tick keeps only the scan, the fold read and the
 * appends.
 *
 * The rule this replaced was discovery-only -- it journaled a `session.started` row when
 * the fold had never heard of a session, and nothing otherwise. Two escapes came out of
 * that on 2026-09-10, both visible on the live console:
 *
 *  - A session wrongly marked `session.vanished` could never come back. Its pid was alive
 *    on every later tick, and the tick had nothing to say about a session it already knew.
 *    Only a hook firing (`session.prompt`) put it back to live, so an idle terminal stayed
 *    dead for as long as nobody typed in it.
 *  - Identity never reached the fold. A hook reports first (`session.prompt` fires on the
 *    first prompt, inside the tick's own cadence) and carries no name, so the tick saw a
 *    known session and stayed quiet: 167 of 169 rows on `GET /sessions` had no name at all.
 *
 * So the tick reconciles rather than discovers, and the two failures above are the two
 * specimens in `tests/forge/sessions/reconcile.test.ts`.
 */
import type { ForgeEvent } from '../journal.js';
import { ingestOne, type IngestDeps } from './ingest.js';
import type { SessionRow } from './registry.js';
import { sessionStartedRow, type SessionStartedRow } from './started-row.js';

/** The subset of the journal's `SessionFoldState` this decision reads. Declared here
 *  rather than imported whole so the planner never grows a dependency on burn, runs or
 *  anything else the fold happens to carry. */
export interface KnownSession {
  status: 'live' | 'ended';
  pid?: number;
  name?: string;
  cwd?: string;
  /** Set by the fold only when a real `SessionEnd` row arrived (journal.ts:367). Its
   *  absence on an `ended` session is what marks an end this tick invented itself. */
  lastStop?: { at: number };
}

export interface VanishedRow {
  event: 'session.vanished';
  actor: 'registry';
  session: string;
  cwd: string;
  [key: string]: unknown;
}

export type RegistryRow = SessionStartedRow | VanishedRow;

/** The same shape `RegistryDeps.probeAlivePid` declares (registry.ts:56), so the probe the
 *  scan already uses drops in here with no adapter: anything truthy means the pid answered. */
export type ProbeAlivePid = (pid: number) => number | string | true | null | undefined;

/** True when the fold is missing identity the scan can supply, or carries a pid the scan
 *  disagrees with (the session file is the authority: a hook reports the short-lived hook
 *  process's pid, never the terminal's). */
function identityIsStale(known: KnownSession, row: SessionRow): boolean {
  if (!known.name && row.name) return true;
  if (row.pid && known.pid !== row.pid) return true;
  return false;
}

/**
 * One tick's journal rows, in order, for the sessions the registry just scanned.
 *
 * `known` is the fold keyed by session id. A scanned row with no session id names nothing
 * to journal and is skipped.
 */
export function planRegistryRows(
  scanned: SessionRow[],
  known: Record<string, KnownSession | undefined>,
  probeAlivePid: ProbeAlivePid,
): RegistryRow[] {
  const rows: RegistryRow[] = [];
  for (const row of scanned) {
    if (!row.sessionId) continue;
    const current = known[row.sessionId];
    if (row.vanished) {
      // Only once: a session already folded `ended` has nothing more to report.
      if (!current || current.status === 'live') {
        rows.push({ event: 'session.vanished', actor: 'registry', session: row.sessionId, cwd: row.cwd });
      }
      continue;
    }
    // The process is alive. Say so when the fold has never heard of it, when the fold has
    // it dead for a reason this tick invented, or when the fold is missing identity only
    // this scan can supply. A fold that already agrees gets no row -- this runs every tick,
    // and a row per tick per session is how the ledger reached 24 MB.
    if (!current) {
      rows.push(sessionStartedRow(row));
      continue;
    }
    if (current.status === 'ended') {
      // Coming back is only ever right for a session this tick wrongly marked vanished.
      // A real `SessionEnd` writes `lastStop`, and a session that ended on purpose must
      // stay ended: on 2026-09-11 a Ctrl-C was folded `ended` and brought back 31 ms later
      // because the process had not finished exiting, then journalled `killed` two seconds
      // on -- turning a deliberate interrupt into a hard kill.
      if (!current.lastStop) rows.push(sessionStartedRow(row));
      continue;
    }
    if (identityIsStale(current, row)) {
      rows.push(sessionStartedRow(row));
    }
  }
  rows.push(...planOrphanRows(scanned, known, probeAlivePid));
  return rows;
}

/**
 * The sessions the fold believes live that the scan never returns at all.
 *
 * `scanSessions` finds a session by its `<pid>.json` file under a config dir. A console SDK
 * worker's file is gone once the console that spawned it dies, so the scan stops returning
 * it while the fold still carries it live -- and the loop above, which only ever walks the
 * scan, has nothing to say about a session that is not in front of it. On 2026-09-11, two
 * minutes after the console restarted onto #142, that was 28 of its 35 live rows, the
 * oldest last heard from at 21:11 the night before.
 *
 * The fold already carries the pid these sessions reported, so no new sensor is needed and
 * no staleness threshold is guessed: the same probe the scan uses answers it. Two rules keep
 * this from ever reaching a session that is not gone:
 *
 *  - a pid that answers the probe is alive, and nothing is written. A session file that
 *    merely disappeared under a running process stays live, which is the safe direction --
 *    a recycled pid reads as alive, never as a kill.
 *  - a fold row carrying no pid is no evidence at all and is left alone. The one nameless
 *    live row on the machine had no pid and no cwd, and sweeping on a guess would release
 *    another session's locks.
 */
function planOrphanRows(
  scanned: SessionRow[],
  known: Record<string, KnownSession | undefined>,
  probeAlivePid: ProbeAlivePid,
): VanishedRow[] {
  const seen = new Set(scanned.map((row) => row.sessionId).filter(Boolean));
  const rows: VanishedRow[] = [];
  for (const [sessionId, current] of Object.entries(known)) {
    if (!current || current.status !== 'live') continue;
    if (seen.has(sessionId)) continue;
    if (typeof current.pid !== 'number') continue;
    if (probeAlivePid(current.pid)) continue;
    rows.push({ event: 'session.vanished', actor: 'registry', session: sessionId, cwd: current.cwd ?? '' });
  }
  return rows;
}

/**
 * One tick's rows, journaled. A `session.vanished` row goes through the same `ingestOne`
 * the `POST /sessions/event` route uses, so a hard kill is classified `killed` and its
 * claims and locks are released; a `session.started` row is plain journal.
 *
 * The tick used to append every row raw. Nothing else ever notices a hard kill, so the
 * cleanup simply never ran for one: 695 `session.vanished` rows on this machine against
 * 2 `session.cleanup` rows.
 */
export function journalRegistryRows(
  rows: RegistryRow[],
  deps: IngestDeps & { append: (row: Partial<ForgeEvent>) => ForgeEvent },
): void {
  for (const row of rows) {
    if (row.event === 'session.vanished') {
      ingestOne(deps, { event: row.event, session: row.session, cwd: row.cwd });
    } else {
      deps.append(row);
    }
  }
}
