/**
 * One record per live goal: who owns it, and whether it is still there.
 *
 * `forge run` used to take its run id from a brief's basename and its cwd from whatever
 * process happened to invoke it, with nothing stopping a second launch of the same goal
 * from the same or a different terminal. This is the registry that closes that: a row is
 * created atomically (open with `wx`, which throws rather than overwrites when the file
 * already exists), so two processes racing to admit the same goal cannot both win.
 *
 * A row that outlives its process is the signal a crash left behind: a `forge run` that
 * finishes normally removes its own row in a `finally`, so anything still there when
 * `forge up` starts either belongs to a run that is genuinely still going (a live pid) or
 * one that ended without a clean finish.
 */
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { Journal, replay } from './journal.js';
import { DEFAULT_THRESHOLDS } from './liveness.js';
import { clearParkRecord } from './parkrecord.js';
import { modelFor, modelIdFor, tierOfBrief, turnsFor } from './policy.js';
import type { EngineLike } from './worker.js';

export interface RegistryRecord {
  /** The run id: the goal this row belongs to. */
  goal: string;
  cwd: string;
  briefPath: string;
  pid: number;
  startedAt: number;
  sessionId?: string;
  model?: string;
}

export interface AdmissionVerdict {
  ok: boolean;
  reason?: string;
}

/** Whether a pid still names a live process. Signal 0 sends nothing; it only asks. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeName(goal: string): string {
  return (goal || 'run').replace(/[^A-Za-z0-9._-]/g, '_');
}

export class Registry {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(goal: string): string {
    return join(this.dir, `${safeName(goal)}.json`);
  }

  get(goal: string): RegistryRecord | undefined {
    const path = this.pathFor(goal);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as RegistryRecord;
    } catch {
      return undefined;
    }
  }

  all(): RegistryRecord[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.get(name.slice(0, -'.json'.length)))
      .filter((row): row is RegistryRecord => Boolean(row));
  }

  /**
   * Admit a new run, or refuse it.
   *
   * Refuses a second live run for the same goal, and a second live run in the same cwd --
   * two goals racing over the one working tree are exactly as unsafe as two runs of one
   * goal. "Live" is read from every row on disk, never from a lane file: the falsifier
   * this closes is admission that only checks the lane file, which the second run itself
   * rewrites and so can never disagree with.
   */
  admit(request: { goal: string; cwd: string; briefPath: string; pid: number }): AdmissionVerdict {
    for (const existing of this.all()) {
      if (!processAlive(existing.pid)) continue;
      if (existing.goal === request.goal) {
        return { ok: false, reason: `goal ${request.goal} already has a live run (pid ${existing.pid})` };
      }
      if (existing.cwd === request.cwd) {
        return {
          ok: false,
          reason: `${request.cwd} already has a live run (goal ${existing.goal}, pid ${existing.pid})`,
        };
      }
    }

    const path = this.pathFor(request.goal);
    const record: RegistryRecord = { ...request, startedAt: Date.now() };
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, JSON.stringify(record, null, 2));
      closeSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const stale = this.get(request.goal);
        return {
          ok: false,
          reason: stale && processAlive(stale.pid)
            ? `goal ${request.goal} already has a live run (pid ${stale.pid})`
            : `a registry row already exists for goal ${request.goal} from a run that did `
              + 'not clean up after itself; run forge up to reconcile it first',
        };
      }
      throw error;
    }
    return { ok: true };
  }

  /** Record the session a run opened, once it has one. */
  setSession(goal: string, sessionId: string, model: string): void {
    const existing = this.get(goal);
    if (!existing) return;
    const path = this.pathFor(goal);
    const fd = openSync(path, 'w');
    try {
      writeSync(fd, JSON.stringify({ ...existing, sessionId, model }, null, 2));
    } finally {
      closeSync(fd);
    }
  }

  /** A run that finished, one way or another, is no longer this registry's business. */
  remove(goal: string): void {
    const path = this.pathFor(goal);
    if (existsSync(path)) rmSync(path);
  }
}

export interface ReconcileOutcome {
  goal: string;
  ok: boolean;
  reason?: string;
}

export type RelaunchOutcome = 'relaunched' | 'skipped';

const RELAUNCH_PROMPT = [
  'The process running this session ended without a clean finish, mid-tool-call: a crash,',
  'a kill, or a machine restart. You are resumed on the same session from where it left',
  'off. Say briefly what you were doing, then carry on.',
].join('\n');

/**
 * B.2: the live-tick counterpart to `reconcileRegistry` below, for a registry row whose
 * process dies mid-tool while `forge up` is already running rather than only at its own
 * startup. Resumes the same goal on the same worktree, by session id, exactly once. The
 * row itself is left untouched either way: a second death under the same name trips the
 * same `registry-abandoned` liveness signal again, so the caller (the Warden tick) can
 * tell a first death from a second without any bookkeeping of its own on disk, and park
 * the run rather than relaunch it a second time.
 */
export async function relaunchAbandonedGoal(
  registry: Registry, engine: EngineLike, goal: string,
): Promise<RelaunchOutcome> {
  const record = registry.get(goal);
  if (!record || !record.sessionId) return 'skipped';
  try {
    const brief = readFileSync(record.briefPath, 'utf8');
    const className = tierOfBrief(brief);
    const model = record.model ?? modelIdFor(modelFor(className));
    await engine.run({
      run: goal, model, prompt: RELAUNCH_PROMPT, env: process.env, cwd: record.cwd,
      maxTurns: turnsFor(className), resume: record.sessionId,
    });
    clearParkRecord(goal);
    return 'relaunched';
  } catch {
    return 'skipped';
  }
}

/**
 * B.3: which dead-pid registry rows are old enough, past their own park, to be reaped.
 * No process is ever signalled here, so this never needs the `decision.made` row Aaron's
 * 2026-09-04 rule reserves for a kill; it only ever acts on a row that is provably no
 * longer live. A row with no park record at all is left alone: it is either still
 * genuinely running (a live pid, filtered out by the caller before this even sees it) or
 * a crash `reconcileRegistry` will pick up on the next `forge up`, not a row this tick has
 * any standing to touch.
 */
export function reapableGoals(
  rows: readonly RegistryRecord[],
  isAlive: (pid: number) => boolean,
  parkedAt: (goal: string) => number | undefined,
  now: number,
  afterMs = 4 * 60 * 60_000,
): string[] {
  const reaped: string[] = [];
  for (const row of rows) {
    if (isAlive(row.pid)) continue;
    const at = parkedAt(row.goal);
    if (at === undefined) continue;
    if (now - at >= afterMs) reaped.push(row.goal);
  }
  return reaped;
}

const RESUME_PROMPT = [
  'The process running this session ended without a clean finish: a crash, a kill, or a',
  'machine restart, rather than forge_done or a park. You are resumed from where it left',
  'off, on the same session. Say briefly what you were doing, then carry on.',
].join('\n');

/**
 * What `forge up` does with every registry row still there at startup.
 *
 * A live pid is left alone: some other process still owns that run, and touching it here
 * would be the same two-supervisor race `owner: "forge"` already exists to prevent
 * elsewhere. A dead pid with no recorded session id cannot be resumed at all -- there is
 * nothing to resume by, so it is reported and dropped rather than silently retried
 * forever; one old enough to have crashed rather than raced its own admission (I12: past
 * `abandonAfterMs`) is journaled as `registry.abandoned` on the way out, so the removal
 * that already happened here is visible, not just inferred from its absence. Everything
 * else gets exactly one resume attempt, success or failure, and its row is cleared either
 * way: this is reconciliation, not a retry loop.
 */
export async function reconcileRegistry(
  registry: Registry, engine: EngineLike, journal: Journal, alive: (pid: number) => boolean = processAlive,
  abandonAfterMs: number = DEFAULT_THRESHOLDS.idleMs,
): Promise<ReconcileOutcome[]> {
  const outcomes: ReconcileOutcome[] = [];
  const now = Date.now();
  // Read once, ahead of the loop: a `run.killed` row is what `WardenActuator.kill`
  // journals (`warden.ts`), and it is the one fact that must outrank a recorded session
  // id below. Kill only stops the OS process -- it never touches this registry's row --
  // so a killed run's stale row looks, to everything else here, exactly like an ordinary
  // crash: dead pid, session id on file, ready to resume. Without this check `forge up`
  // resumed a run a person had deliberately killed, spent real API cost re-running it,
  // and left the board reading it `running` forever once the resume's own fresh events
  // pushed `run.killed` out of being the run's last event.
  const killedGoals = new Set(
    replay(journal.filePath).events
      .filter((event) => event.event === 'run.killed' && typeof event.run === 'string')
      .map((event) => event.run as string),
  );
  for (const record of registry.all()) {
    if (alive(record.pid)) continue;

    if (killedGoals.has(record.goal)) {
      const reason = "the journal already recorded this run as killed, and a dead pid doesn't get to reverse that";
      outcomes.push({ goal: record.goal, ok: false, reason });
      clearParkRecord(record.goal);
      registry.remove(record.goal);
      continue;
    }

    if (!record.sessionId) {
      const age = now - record.startedAt;
      const reason = `no session id was recorded before it stopped (${Math.round(age / 1000)}s old)`;
      if (age >= abandonAfterMs) {
        journal.append({ event: 'registry.abandoned', run: record.goal, actor: 'runner', reason, age });
      }
      outcomes.push({ goal: record.goal, ok: false, reason });
      registry.remove(record.goal);
      continue;
    }

    try {
      const brief = readFileSync(record.briefPath, 'utf8');
      const className = tierOfBrief(brief);
      const model = record.model ?? modelIdFor(modelFor(className));
      await engine.run({
        run: record.goal, model, prompt: RESUME_PROMPT, env: process.env, cwd: record.cwd,
        maxTurns: turnsFor(className), resume: record.sessionId,
      });
      // I13: whatever a Warden wrote for the crashed segment is over with it; the
      // resumed run gets a clean park state, not one it never asked to be under.
      clearParkRecord(record.goal);
      journal.append({
        event: 'run.resumed', run: record.goal, actor: 'runner', reason: 'reconciled by forge up',
      });
      outcomes.push({ goal: record.goal, ok: true });
    } catch (error) {
      outcomes.push({ goal: record.goal, ok: false, reason: (error as Error).message });
    }
    registry.remove(record.goal);
  }
  return outcomes;
}
