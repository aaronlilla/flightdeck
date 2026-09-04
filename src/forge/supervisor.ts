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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
