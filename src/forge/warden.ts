/**
 * Warden's own actuator: the one thing in this stream allowed to act on a run.
 *
 * `liveness.ts` says it plainly -- "this only watches" -- and everything upstream of this
 * file still only watches. `WardenActuator` implements `contracts.ts`'s `Actuator`
 * (`park`, `nudge`, `resume`, `kill`) over the cross-process transports B.3 already built:
 * park writes the `park.json` record from `parkrecord.ts`, which the PreToolUse hook now
 * checks on the run's own process; nudge and resume both ride the run's own inbox
 * (`runinbox.ts`), which delivers as `additionalContext` on the run's next tool call; kill
 * is the one path with a gate of its own, because it is the one action here that is not
 * reversible.
 */
import { readFileSync } from 'node:fs';

import type { Actuator, DecisionId } from './contracts.js';
import { replayEvents } from './contracts.js';
import { killTree } from './exec.js';
import { Journal } from './journal.js';
import { clearParkRecord, writeParkRecord } from './parkrecord.js';
import type { Registry } from './registry.js';
import { RunInbox } from './runinbox.js';
import type { Lanes } from './supervisor.js';

export interface WardenActuatorDeps {
  journal: Journal;
  /** Read fresh on every `kill` call, so a `decision.made` row written a moment ago by a
   *  separate `forge decide` process is seen without this actuator holding a second,
   *  possibly stale, view of the same file. */
  journalPath: string;
  registry: Registry;
  lanes?: Lanes;
  /** Defaults to the real `killTree`. A specimen injects a fake so no process is ever
   *  signalled from a test, per this stream's zero-spend rule. */
  killProcess?: (pid: number) => void;
}

/**
 * The `decision.made` row that authorises a kill, or `undefined` when none names this
 * run and this action.
 *
 * Reads the whole journal through `replayEvents` rather than a bespoke parser, so a torn
 * tail or a duplicate id is handled the one way the rest of Forge already agreed on,
 * instead of a second, slightly different reader for this one lookup.
 */
export function findDecision(
  journalPath: string, run: string, action: string, decisionId: DecisionId,
): { id: string; run: string; action: string; reason?: string } | undefined {
  let text: string;
  try {
    text = readFileSync(journalPath, 'utf8');
  } catch {
    return undefined;
  }
  const { events } = replayEvents(text);
  const found = events.find((event) => (
    event.id === decisionId
    && event.event === 'decision.made'
    && event.run === run
    && event['action'] === action
  ));
  if (!found) return undefined;
  return {
    id: found.id, run: found.run ?? run, action: found['action'] as string,
    reason: found['reason'] as string | undefined,
  };
}

export class WardenActuator implements Actuator {
  constructor(private readonly deps: WardenActuatorDeps) {}

  /**
   * A run id with no registry row and no lane file is not a run. It is a fleet process
   * id, or some other string a caller mistook for one (I11). This is the one check
   * `park`'s park record and lane put both sit behind.
   */
  private isRegistered(run: string): boolean {
    return Boolean(this.deps.registry.get(run)) || Boolean(this.deps.lanes?.get(run));
  }

  /**
   * A run id with no registry row and no lane gets `warden.refused` in the journal and
   * nothing written to disk. This is the backstop behind the tick's own registration
   * check (`warden-tick.ts`): whatever else calls this actuator directly still cannot
   * park a phantom.
   */
  async park(run: string, reason: string): Promise<boolean> {
    if (!this.isRegistered(run)) {
      this.deps.journal.append({
        event: 'warden.refused', run, actor: 'warden', action: 'park',
        reason: 'no registry row and no lane names this run',
      });
      return false;
    }
    const at = Date.now();
    writeParkRecord(run, { key: `warden:${run}`, reason, at });
    this.deps.lanes?.put(run, { needs_aaron: reason });
    this.deps.journal.append({ event: 'run.parked', run, actor: 'warden', reason });
    return true;
  }

  async nudge(run: string, message: string): Promise<void> {
    new RunInbox(run).send(message, 'warden');
  }

  async resume(run: string, input: string): Promise<void> {
    clearParkRecord(run);
    new RunInbox(run).send(input, 'warden');
    this.deps.journal.append({ event: 'run.resumed', run, actor: 'warden' });
  }

  /**
   * Refuses silently -- journaling `warden.refused` and touching no process -- unless a
   * `decision.made` row names this exact run and `kill`. A `decisionId` this actuator
   * invented, or one that names a different run or a different action, is refused the
   * same way a missing one is: the only thing that authorises a kill is a row a person
   * wrote.
   */
  async kill(run: string, decisionId: DecisionId): Promise<void> {
    const decision = findDecision(this.deps.journalPath, run, 'kill', decisionId);
    if (!decision) {
      this.deps.journal.append({
        event: 'warden.refused', run, actor: 'warden', decisionId,
        reason: 'no decision.made row names this run and kill',
      });
      return;
    }

    const record = this.deps.registry.get(run);
    const kill = this.deps.killProcess ?? killTree;
    if (record) kill(record.pid);

    // `needs_aaron` outranks every other check in `laneStateFor` (console/lanes.ts), so
    // killing a run the console had already allowed to kill from `blocked` (closing the
    // dead end where that state offered neither Resume nor Kill) left the tile reading
    // `blocked` forever, "Gate log ->" its only action, even once the journal below says
    // `run.killed` and the process is gone. Clearing it here is what lets a killed lane
    // actually read `killed`.
    this.deps.lanes?.put(run, { verdict: 'killed', ended: Date.now(), needs_aaron: null });
    this.deps.journal.append({
      event: 'run.killed', run, actor: 'warden', decisionId, evidence: [decision.id],
      pid: record?.pid,
    });
  }
}
