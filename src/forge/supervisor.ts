/**
 * Lane records, and the breaker that stops a lane being relaunched forever.
 *
 * A lane record is the file everything else opens to see what a worker is doing: the old
 * dashboard, the classifier, and a person with a text editor. Forge keeps the fields
 * those readers already use, adds the four the old runtime never had, and drops `window`,
 * which described a terminal that no longer exists.
 *
 * `owner` is the load-bearing addition. Forge supervises its own workers, and the old
 * warden must leave them alone: two supervisors over one session is not redundancy but a
 * race, and on 2026-09-03 a wake and a recycle landed twelve seconds apart and the goal
 * came out of it holding no session at all.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Journal } from './journal.js';
import { RunInbox } from './runinbox.js';
import { HANDOFF_REQUEST } from './worker.js';

/**
 * Every field a lane record carries.
 *
 * Written down because the readers are in another language and another repository: an
 * added field is free, a renamed one breaks a dashboard silently, and a specimen over
 * this list is what turns that into a red row instead of a blank column.
 */
export const LANE_FIELDS = [
  'slug', 'column', 'owner', 'session_id', 'claude_pid', 'started', 'ended',
  'verdict', 'position', 'note', 'woken', 'model', 'context', 'cost_usd', 'handoff',
] as const;

export type LaneField = (typeof LANE_FIELDS)[number];

export interface LaneRecord {
  slug: string;
  column: string;
  /** Who supervises this lane. `forge` means the old warden takes no action on it. */
  owner: string;
  session_id: string | null;
  claude_pid: number | null;
  started: number | null;
  ended: number | null;
  verdict: string | null;
  position: number | null;
  note: string | null;
  woken: number;
  /** The model this lane's session runs on, so a board can show it without guessing. */
  model: string | null;
  /** Tokens the newest turn re-read. The number the whole ceiling exists to bound. */
  context: number;
  /** List-equivalent dollars this lane has spent, added up from its usage events. */
  cost_usd: number;
  /** The successor a handoff named, when one has happened. */
  handoff: string | null;
  /** Set by the breaker. While it is set, nothing relaunches this lane. */
  needs_aaron?: string | null;
  /** Timestamps of starts that took no turns, inside the rolling window. */
  zero_turn_starts?: number[];
}

/** A record with every field present, so a reader never has to guess at a missing key. */
export function laneRecord(fields: Partial<LaneRecord> & { slug: string; column: string }): LaneRecord {
  return {
    owner: 'forge',
    session_id: null,
    claude_pid: null,
    started: null,
    ended: null,
    verdict: null,
    position: null,
    note: null,
    woken: 0,
    model: null,
    context: 0,
    cost_usd: 0,
    handoff: null,
    ...fields,
  };
}

/** One JSON file per lane, which is what makes the board readable without the runner. */
export class Lanes {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(slug: string): string {
    return join(this.dir, `${slug}.json`);
  }

  get(slug: string): LaneRecord | undefined {
    const path = this.pathFor(slug);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as LaneRecord;
    } catch {
      return undefined;
    }
  }

  /**
   * When a lane's file was last written, read fresh from disk every call.
   *
   * This is what lets a reader say a lane's state is only as current as its last write,
   * rather than trusting an in-memory copy that may already be stale.
   */
  mtimeOf(slug: string): number | undefined {
    const path = this.pathFor(slug);
    if (!existsSync(path)) return undefined;
    return statSync(path).mtimeMs;
  }

  /** Merge fields into a lane. Never a replace: two writers would lose each other's work. */
  put(slug: string, fields: Partial<LaneRecord>): LaneRecord {
    const existing = this.get(slug);
    const merged = laneRecord({
      column: existing?.column ?? fields.column ?? '',
      ...existing,
      ...fields,
      slug,
    });
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.pathFor(slug), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    return merged;
  }

  all(): LaneRecord[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.get(name.slice(0, -'.json'.length)))
      .filter((row): row is LaneRecord => Boolean(row));
  }
}

export interface BreakerVerdict {
  blocked: boolean;
  count: number;
  reason?: string;
}

/**
 * Stops a lane whose sessions keep starting and doing nothing.
 *
 * A session that starts and takes no turns is a failed start, not a worker being quiet.
 * The old relaunch logic could not tell those apart and relaunched forever, which is the
 * burst shape in the 14:43 thrash on 2026-09-03. Three failed starts inside fifteen
 * minutes stop it, because the fourth attempt has never once been the one that worked.
 *
 * Counted in a rolling window rather than for the life of the goal: a worker that failed
 * to start this morning, ran all afternoon and failed once tonight has not failed three
 * times, and counting it that way retires healthy lanes.
 *
 * The block itself does not roll off. A window that clears the flag would relaunch the
 * lane fifteen minutes later without anyone having looked, which is the loop this exists
 * to break.
 */
export class Breaker {
  static readonly WINDOW_MS = 15 * 60 * 1000;

  static readonly LIMIT = 3;

  constructor(private readonly lanes: Lanes) {}

  noteZeroTurnStart(slug: string, now: number = Date.now()): BreakerVerdict {
    const record = this.lanes.get(slug);
    const kept = (record?.zero_turn_starts ?? [])
      .filter((at) => typeof at === 'number' && now - at < Breaker.WINDOW_MS);
    kept.push(now);

    const blocked = kept.length >= Breaker.LIMIT;
    const reason = blocked
      ? `${kept.length} starts in ${Breaker.WINDOW_MS / 60000} minutes each ended without `
        + 'taking a turn; nothing is being relaunched until someone looks at why'
      : undefined;

    this.lanes.put(slug, {
      zero_turn_starts: kept,
      ...(blocked ? { needs_aaron: reason } : {}),
    });
    return { blocked: this.blocked(slug), count: kept.length, ...(reason ? { reason } : {}) };
  }

  /** A session that did work clears the count. Consecutive failures are what matter. */
  noteWorkingStart(slug: string): void {
    this.lanes.put(slug, { zero_turn_starts: [] });
  }

  blocked(slug: string): boolean {
    return Boolean(this.lanes.get(slug)?.needs_aaron);
  }

  /** Hand a flagged lane back once a person has looked at it. */
  clear(slug: string): void {
    this.lanes.put(slug, { needs_aaron: null, zero_turn_starts: [] });
  }
}


/**
 * The whole fleet, and the one control that has to work when nothing else does.
 *
 * `forge stop --all` marks every running lane parked and blocks every new launch behind
 * the kill switch below. It does not reach a live session: a worker mid-turn keeps
 * running until that turn ends, because nothing here contacts the process. Everything
 * about it is shaped by the fact that it will be reached for when something is going
 * wrong: it takes no arguments it could get wrong, it is safe to run twice, and it never
 * fails because a lane was already finished.
 *
 * Parking rather than killing, because the work has to survive. Every run is asked for a
 * handoff packet as it stops, so `forge up` continues rather than starting over. A stop
 * that lost an afternoon of work would be a stop nobody dares press.
 */
export interface KillSwitchState {
  engaged: boolean;
  reason?: string;
  at?: number;
}

/** Blocks `forge run` until cleared. Read fresh every time: nothing caches it. */
export function readKillSwitch(path: string): KillSwitchState {
  if (!existsSync(path)) return { engaged: false };
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as { reason: string; at: number };
    return { engaged: true, reason: record.reason, at: record.at };
  } catch {
    // An unreadable kill switch file still means someone tried to stop everything; failing
    // open here would be the same silent-empty-fleet mistake liveness's sensor made.
    return { engaged: true, reason: 'the kill switch file exists but could not be read' };
  }
}

export function engageKillSwitch(path: string, reason: string): void {
  writeFileSync(path, JSON.stringify({ reason, at: Date.now() }, null, 2), 'utf8');
}

export function clearKillSwitch(path: string): void {
  if (existsSync(path)) rmSync(path);
}

/**
 * A session `Fleet.stopAll` can reach directly, because this same process holds it.
 *
 * `send` mirrors `SessionResult.send`: it resolves with whatever the session wrote back
 * (the handoff packet, when it wrote one), which is how `stopAll` tells "reached" from
 * "unreachable" without guessing.
 */
export interface LiveSession {
  send(text: string): Promise<unknown>;
  stop(): Promise<void>;
}

/** A stopped lane, with whether this process actually contacted its session. */
export type StopOutcome = LaneRecord & { reached: boolean };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

export class Fleet {
  /** How long `stopAll` waits for a live session to answer before giving up on it. */
  static readonly IDLE_BUDGET_MS = 30_000;

  private readonly journal: Journal;

  constructor(
    private readonly lanes: Lanes,
    journalPath: string,
    private readonly killSwitchFile?: string,
    /** Sessions this process holds directly, keyed by lane slug. Empty in production: a
     *  `forge stop` invocation is its own process and never holds another run's session. */
    private readonly liveSessions: Map<string, LiveSession> = new Map(),
  ) {
    this.journal = new Journal(journalPath);
  }

  /** Lanes that are still doing something, and so still costing something. */
  running(): LaneRecord[] {
    return this.lanes.all().filter((row) => !row.ended && !row.verdict);
  }

  /**
   * Park every running lane, engage the kill switch, and say what was stopped.
   *
   * The kill switch engages every time this runs, whether or not a lane was running: a
   * stop on an idle fleet still means "block whatever launches next." Returns the lanes it
   * acted on, which is empty when there was nothing to park. An empty list is the honest
   * answer to a stop on an idle fleet; raising there would make the control feel broken at
   * the moment it is most needed.
   *
   * A lane this process holds a `LiveSession` for is contacted directly: the handoff
   * request goes in through `send()`, raced against `idleBudgetMs`, then the session is
   * stopped either way. A lane with no live session (the normal case for `forge stop`,
   * a separate process from whatever `forge run` is doing) gets its handoff request queued
   * into the run's own inbox, where the PreToolUse hook delivers it on that run's next
   * tool call -- but this process has no way to confirm that happened, so it is marked
   * `reached: false` rather than assumed parked.
   */
  async stopAll(reason: string, idleBudgetMs: number = Fleet.IDLE_BUDGET_MS): Promise<StopOutcome[]> {
    if (this.killSwitchFile) engageKillSwitch(this.killSwitchFile, reason);
    const stopped: StopOutcome[] = [];
    try {
      for (const lane of this.running()) {
        const live = this.liveSessions.get(lane.slug);
        let reached = false;
        let packet: string | undefined;

        if (live) {
          const outcome = await Promise.race([
            live.send(HANDOFF_REQUEST).then((value) => ({ kind: 'sent' as const, value })),
            sleep(idleBudgetMs).then(() => ({ kind: 'timeout' as const, value: undefined })),
          ]);
          await live.stop();
          reached = outcome.kind === 'sent';
          if (reached && typeof outcome.value === 'string') packet = outcome.value;
        } else {
          new RunInbox(lane.slug).send(HANDOFF_REQUEST, 'console');
        }

        this.journal.append({
          event: 'run.parked',
          run: lane.slug,
          actor: 'console',
          reason: reached ? reason : `${reason}; not confirmed inside the idle budget`,
          verdict: 'parked',
          handoffRequested: true,
          reached,
          ...(packet ? { packet } : {}),
        });
        const record = this.lanes.put(lane.slug, {
          verdict: 'parked',
          ended: Date.now(),
          note: reached ? `stopped: ${reason}` : `stopped: ${reason}; unreachable, queued to inbox`,
        });
        stopped.push({ ...record, reached });
      }
    } finally {
      this.journal.close();
    }
    return stopped;
  }
}
