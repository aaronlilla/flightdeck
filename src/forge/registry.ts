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

import { Journal } from './journal.js';
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
 * forever. Everything else gets exactly one resume attempt, success or failure, and its
 * row is cleared either way: this is reconciliation, not a retry loop.
 */
export async function reconcileRegistry(
  registry: Registry, engine: EngineLike, journal: Journal,
): Promise<ReconcileOutcome[]> {
  const outcomes: ReconcileOutcome[] = [];
  for (const record of registry.all()) {
    if (processAlive(record.pid)) continue;

    if (!record.sessionId) {
      outcomes.push({ goal: record.goal, ok: false, reason: 'no session id was recorded before it stopped' });
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
