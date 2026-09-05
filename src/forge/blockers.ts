/**
 * A blocker key, and every run parked behind it.
 *
 * "An ask typed `blocker`, a lock held by a live session, one command failing three
 * times, a tier pause" all raise the same shape: a key (lock, service, branch), the runs
 * sitting behind it, and one event told once no matter how many runs hit the same wall.
 * Clearing the key resumes every run behind it in the order it recorded them arriving,
 * because that is the order they were actually waiting in.
 */
import type { Journal } from './journal.js';

export interface BlockerActuator {
  park(run: string, reason: string): Promise<boolean>;
  resume(run: string, input: string): Promise<void>;
}

export interface BlockerBoardDeps {
  journal: Journal;
  actuator: BlockerActuator;
}

export class BlockerBoard {
  /** Runs behind each key, in the order they arrived. */
  private readonly runsByKey = new Map<string, string[]>();

  /** Keys a `blocker.raised` row has already been written for, so three runs sharing one
   *  key produce one event, not three. */
  private readonly raised = new Set<string>();

  constructor(private readonly deps: BlockerBoardDeps) {}

  /** Every run currently parked behind `key`, in arrival order. */
  runsFor(key: string): string[] {
    return [...(this.runsByKey.get(key) ?? [])];
  }

  /**
   * Park `run` behind `key`. The first run to hit a key writes the `blocker.raised` row;
   * every run after it parks the same way with no second event, because the wall they hit
   * is the one the first row already named.
   */
  async raise(key: string, what: string, run: string): Promise<void> {
    const runs = this.runsByKey.get(key) ?? [];
    if (!runs.includes(run)) runs.push(run);
    this.runsByKey.set(key, runs);

    await this.deps.actuator.park(run, `blocked on ${key}: ${what}`);

    if (!this.raised.has(key)) {
      this.raised.add(key);
      this.deps.journal.append({
        event: 'blocker.raised', actor: 'warden', key, what, runs: [...runs],
      });
    }
  }

  /**
   * Clear `key`: every run behind it resumes, in the order they were recorded arriving,
   * and the key stops existing so a fresh raise starts a clean list.
   */
  async clear(key: string, resumeMessage: string = `the blocker on ${key} cleared; carry on`): Promise<string[]> {
    const runs = this.runsFor(key);
    for (const run of runs) {
      await this.deps.actuator.resume(run, resumeMessage);
    }
    this.raised.delete(key);
    this.runsByKey.delete(key);
    this.deps.journal.append({ event: 'blocker.cleared', actor: 'warden', key, runs });
    return runs;
  }
}
