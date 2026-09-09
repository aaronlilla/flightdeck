/**
 * The `forge up` liveness cadence, wiring Warden's own primitives into the tick that was
 * merely watching before this integration (P4.7/I2). `reportFleetHealth`,
 * `assessCostShape` and the actuator's park all shipped correct and tested in the Warden
 * stream; nothing in production called any of them. This is that call, in the order the
 * integration brief names it, each step guarded so one throw never stops the rest.
 *
 * Only `WardenActuator.park` is ever reached from here. A kill needs a `decision.made`
 * row a person wrote (`forge decide`), which this tick never manufactures.
 */
import type { BlockerBoard } from './blockers.js';
import type { ConformanceDriftDeps } from './conformance-drift.js';
import { ConformanceDrift, extractDoD } from './conformance-drift.js';
import type { ExtendedStuckSignal, Reasoner } from './contracts.js';
import { assessCostShape, type CostShapeInput } from './cost-shape.js';
import { reportFleetHealth } from './fleet-health.js';
import type { Journal } from './journal.js';
import { wardenConfig } from './policy.js';
import { reapableGoals, type RegistryRecord, type RelaunchOutcome } from './registry.js';
import type { WardenActuator } from './warden.js';

export interface WardenTickRun {
  run: string;
  /** The brief text, for the conformance checker's `## Definition of Done` extraction.
   *  A run with none is skipped by the drift check, the same as `extractDoD` itself. */
  brief?: string;
  recentToolCalls: string[];
  costShape: Omit<CostShapeInput, 'now'>;
}

export interface CredentialAccount {
  account: string;
  probeValid: () => boolean | Promise<boolean>;
}

/** The subset of `CredentialHorizon` this tick needs: resuming every run parked behind a
 *  lapsed account once its credential is valid again. Typed narrowly so a specimen can
 *  fake it with one method rather than the whole class's launch-time dependencies
 *  (`notifyAaron`, `startFlow`), which this cadence never touches. */
export interface CredentialHorizonLike {
  tick(account: string, probeValid: () => boolean | Promise<boolean>): Promise<boolean>;
}

export interface WardenTickDeps {
  journal: Journal;
  actuator: WardenActuator;
  blockers: BlockerBoard;
  now: () => number;
  stuck: () => ExtendedStuckSignal[];
  liveRuns: () => WardenTickRun[];
  /** Whether `key` names a real run: a registry row, or a lane with a live run. A
   *  `stale-session` or `login-stuck` trip keys on a fleet pid (`pid:N`), which is never
   *  a run name; asking this before parking is what stops the tick from parking someone
   *  else's process (I11). Defaults to always true, so a caller with no registry or lane
   *  wired up yet keeps today's behavior rather than silently downgrading every park to
   *  a health row. */
  isRegisteredRun?: (key: string) => boolean;
  reasoner?: Reasoner;
  /** Injected so a specimen can force a throw without touching a real process list;
   *  defaults to the real `reportFleetHealth`. */
  reportFleetHealth?: (journal: Journal, stuck: ExtendedStuckSignal[]) => number;
  credentialHorizon?: CredentialHorizonLike;
  openCredentialAccounts?: () => CredentialAccount[];
  /** Every ten turns or five minutes per run, per the roadmap's own cadence. Defaults to
   *  always due, since the cadence is a property of when the caller chooses to ask, not
   *  of the checker itself. */
  dueForConformanceCheck?: (run: string) => boolean;
  onError?: (label: string, error: unknown) => void;

  /** B.2: resumes one registry-abandoned goal, once, on the same worktree. Undefined
   *  means the tick only journals the trip (today's behavior) and never relaunches
   *  anything -- a caller that has not wired real relaunch mechanics keeps working
   *  exactly as before this integration. */
  relaunchAbandoned?: (goal: string) => Promise<RelaunchOutcome>;

  /** B.3: every registry row currently on disk, for the reap sweep. Paired with `isAlive`
   *  and `parkedAt`; all three undefined is a no-op, the same opt-in shape as everything
   *  else on this tick. */
  registryRows?: () => readonly RegistryRecord[];
  isAlive?: (pid: number) => boolean;
  /** When a goal was last parked, or undefined when it never was (or the record has
   *  already been cleared). Read fresh every tick, the same as every other cross-process
   *  fact this tick consults. */
  parkedAt?: (goal: string) => number | undefined;
  releaseRegistryRow?: (goal: string) => void;
  /** Flags the row's lane `dead` the same way a board reads any other terminal state. */
  markLaneDead?: (goal: string) => void;
  /** Defaults to 4 hours, the bound named in the roadmap. */
  reapAfterMs?: number;

  /** B.6: the kill switch state, read fresh every tick. Engaged and nothing else wrong
   *  still gets one `warden.health` line every 30 minutes, so a switch nobody remembers
   *  engaging stays visible without this tick ever clearing it itself -- clearing stays a
   *  person's call, per Aaron's 2026-09-04 rule. */
  killSwitch?: () => { engaged: boolean; reason?: string };

  /** R-02 guard #3: every currently-running queue item whose repo is the self repo, with
   *  its own roadmap id (or null/undefined if it has none). Absent means this tick never
   *  checks for an off-roadmap lane, the same opt-in default every other dep here uses. */
  selfRepoBriefLanes?: () => Array<{ run: string; roadmap?: string | null }>;
}

/** Signals `assess()` can raise that name a run and are safe for a generic actuator park.
 *  `fleet-unknown` names the probe, not a run (`reportFleetHealth`'s own job, never
 *  acted on); `drift` and `blocker` already parked themselves the moment they were
 *  raised (`ConformanceDrift.check`, `BlockerBoard.raise`), so parking them again here
 *  would be a second, redundant park record for the same trip. `context` is excluded on
 *  purpose (I13): the worker owns its own ceiling and already hands off or parks on it
 *  (B.3.3), so a second actuator acting on the same number is redundant at best, and
 *  wrong at worst -- a finished chain's last `turn.end` leaves `RunState.context` sitting
 *  at its old high-water mark until a new run under the same name records its own first
 *  turn, since `run.started` never resets it, so a fresh attempt of the same goal can
 *  read as already over the ceiling before it has made a single tool call. */
const GENERIC_PARK_SIGNALS = new Set([
  'idle', 'tool-budget', 'stale-session', 'login-stuck',
]);

async function guarded(
  label: string, fn: () => Promise<void> | void, onError?: (label: string, error: unknown) => void,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    onError?.(label, error);
  }
}

export class WardenTick {
  private readonly drift: ConformanceDrift | undefined;

  /** Trip ids (`key:signal`) already parked, so an open trip that has not cleared is
   *  parked once, not once per tick, over however many ticks it stays open. */
  private readonly parkedTrips = new Set<string>();

  /** B.2: goals already given their one relaunch. A registry-abandoned trip for a goal
   *  in here means the relaunch itself died mid-tool too, and this time it parks. */
  private readonly relaunchedGoals = new Set<string>();

  /** B.2: goals whose `relaunchAbandoned()` call has been sent but has not resolved
   *  yet -- `engine.run()` inside it only returns when the relaunched run itself ends,
   *  minutes later, and the same registry row keeps tripping `registry-abandoned` on
   *  every 30s tick in between (the row is deliberately left with the dead pid; see the
   *  doc comment on `relaunchAbandonedGoal`). A goal in here is skipped outright, not
   *  parked and not relaunched again, until that call settles. Cleared once the call
   *  resolves either way. */
  private readonly relaunchInFlight = new Set<string>();

  /** B.2: when each goal's relaunch was sent, for telling a live relaunched run apart
   *  from a genuine second death (see `handleAbandoned`). */
  private readonly relaunchedAt = new Map<string, number>();

  /** B.6: the last time the kill switch got its visibility line, so it repeats on a
   *  cadence rather than every 30 seconds this tick runs. */
  private lastKillSwitchNoticeAt: number | undefined;

  constructor(private readonly deps: WardenTickDeps) {
    if (deps.reasoner) {
      const driftDeps: ConformanceDriftDeps = {
        reasoner: deps.reasoner, journal: deps.journal, actuator: deps.actuator,
      };
      this.drift = new ConformanceDrift(driftDeps);
    }
  }

  async run(): Promise<void> {
    const onError = this.deps.onError;
    const reportHealth = this.deps.reportFleetHealth ?? reportFleetHealth;

    await guarded('reportFleetHealth', () => {
      reportHealth(this.deps.journal, this.deps.stuck());
    }, onError);

    await this.parkGenericTrips(onError);
    await this.handleAbandoned(onError);
    await this.reapDead(onError);
    await this.assessCostShapes(onError);
    await this.checkConformance(onError);
    await this.resumeClearedCredentials(onError);
    await this.noteKillSwitch(onError);
    await this.parkOffRoadmap(onError);
  }

  /** B.2: one relaunch per goal, ever, then a park. */
  private async handleAbandoned(onError?: (label: string, error: unknown) => void): Promise<void> {
    const trips = this.deps.stuck().filter((trip) => trip.signal === 'registry-abandoned');
    for (const trip of trips) {
      const id = `${trip.key}:${trip.signal}`;
      if (this.parkedTrips.has(id)) continue;

      // A trip whose `since` is newer than the goal's own relaunch time is the resumed
      // run still producing events, not a second death -- the registry row stays stale
      // by design (see `relaunchAbandonedGoal`'s doc comment), so the row alone can
      // never be the judge here; the run's own activity is.
      const relaunchedAt = this.relaunchedAt.get(trip.key);
      if (relaunchedAt !== undefined && trip.since > relaunchedAt) continue;

      // A relaunch sent on an earlier tick and not yet resolved: `engine.run()` only
      // returns when the relaunched run ends, so every tick until then sees the same
      // open trip. Wait for it rather than sending a second one.
      if (this.relaunchInFlight.has(trip.key)) continue;

      await guarded(`relaunch:${id}`, async () => {
        const alreadyRelaunched = this.relaunchedGoals.has(trip.key);
        if (alreadyRelaunched || !this.deps.relaunchAbandoned) {
          const hint = alreadyRelaunched
            ? `run ${trip.key} was relaunched once already and died again; parking it `
              + 'rather than relaunching a second time'
            : trip.hint;
          const parked = await this.deps.actuator.park(trip.key, hint);
          if (!parked) return;
          this.deps.journal.append({
            event: 'warden.parked', run: trip.key, actor: 'warden', signal: trip.signal, evidence: trip,
          });
          this.parkedTrips.add(id);
          return;
        }

        this.relaunchInFlight.add(trip.key);
        let outcome: RelaunchOutcome;
        try {
          outcome = await this.deps.relaunchAbandoned(trip.key);
        } finally {
          this.relaunchInFlight.delete(trip.key);
        }
        if (outcome === 'relaunched') {
          this.relaunchedGoals.add(trip.key);
          this.relaunchedAt.set(trip.key, this.deps.now());
          this.deps.journal.append({
            event: 'run.relaunched', run: trip.key, actor: 'warden', reason: trip.hint,
          });
        }
      }, onError);
    }
  }

  /** B.3: a dead pid whose park is older than the bound is released, never signalled. */
  private async reapDead(onError?: (label: string, error: unknown) => void): Promise<void> {
    if (!this.deps.registryRows) return;
    await guarded('reapDead', async () => {
      const isAlive = this.deps.isAlive ?? (() => true);
      const parkedAt = this.deps.parkedAt ?? (() => undefined);
      const goals = reapableGoals(
        this.deps.registryRows!(), isAlive, parkedAt, this.deps.now(), this.deps.reapAfterMs,
      );
      for (const goal of goals) {
        this.deps.releaseRegistryRow?.(goal);
        this.deps.markLaneDead?.(goal);
        this.deps.journal.append({ event: 'registry.reaped', run: goal, actor: 'warden' });
      }
    }, onError);
  }

  /** B.6: engaged and quiet still gets a line on the board every 30 minutes. */
  private async noteKillSwitch(onError?: (label: string, error: unknown) => void): Promise<void> {
    if (!this.deps.killSwitch) return;
    await guarded('killSwitchVisibility', () => {
      const state = this.deps.killSwitch!();
      if (!state.engaged) {
        this.lastKillSwitchNoticeAt = undefined;
        return;
      }
      const now = this.deps.now();
      if (this.lastKillSwitchNoticeAt !== undefined && now - this.lastKillSwitchNoticeAt < 30 * 60_000) {
        return;
      }
      this.lastKillSwitchNoticeAt = now;
      this.deps.journal.append({
        event: 'warden.health', actor: 'warden', key: 'kill-switch', signal: 'kill-switch',
        evidence: state,
      });
    }, onError);
  }

  /** R-02 guard #3: parks any self-repo lane whose item names no roadmap id, through the
   *  same blockers path every other wall on a run goes through. */
  private async parkOffRoadmap(onError?: (label: string, error: unknown) => void): Promise<void> {
    if (!this.deps.selfRepoBriefLanes) return;
    await guarded('offRoadmap', async () => {
      for (const lane of this.deps.selfRepoBriefLanes!()) {
        if (lane.roadmap) continue;
        await this.deps.blockers.raise('off-roadmap', 'off-roadmap: no R-id on the brief', lane.run);
      }
    }, onError);
  }

  private async parkGenericTrips(onError?: (label: string, error: unknown) => void): Promise<void> {
    const isRegistered = this.deps.isRegisteredRun ?? (() => true);
    const open = this.deps.stuck().filter((trip) => GENERIC_PARK_SIGNALS.has(trip.signal));
    const openIds = new Set(open.map((trip) => `${trip.key}:${trip.signal}`));

    for (const trip of open) {
      const id = `${trip.key}:${trip.signal}`;
      if (this.parkedTrips.has(id)) continue;

      await guarded(`park:${id}`, async () => {
        // health-repeat (S-b9d39bae548707e0): reported here shares `parkedTrips` with the
        // parked branch below, not a set of its own -- an open trip is announced once
        // either way, and the cleanup loop at the bottom of this method already clears
        // whichever kind of id it was the moment the trip stops being open, so a re-trip
        // still gets its own fresh line.
        const health = (): void => {
          this.deps.journal.append({
            event: 'warden.health', actor: 'warden', key: trip.key, signal: trip.signal, evidence: trip,
          });
          this.parkedTrips.add(id);
        };

        // `trip.key`'s own pre-check: a fleet pid the tick was never meant to act on
        // (I11) skips calling the actuator at all, the common case for a `pid:N` key
        // that never has a registry row or a lane. This is an optimisation, not the
        // decision of record -- see below.
        if (!isRegistered(trip.key)) {
          health();
          return;
        }

        // I11b: the pre-check above and the actuator's own registration check are two
        // reads of the same registry, one before this call and one inside it, and a
        // live fleet can change between them (the 2026-09-04 22:28 incident: the tick
        // believed a `pid:N` key was registered, the actuator refused it underneath,
        // and the tick journaled `warden.parked` anyway because it never looked at what
        // the actuator actually did). So the journal is decided from the actuator's
        // real answer, never from the pre-check that got it to call the actuator.
        const parked = await this.deps.actuator.park(trip.key, trip.hint);
        if (!parked) {
          health();
          return;
        }
        this.deps.journal.append({
          event: 'warden.parked', run: trip.key, actor: 'warden', signal: trip.signal, evidence: trip,
        });
        this.parkedTrips.add(id);
      }, onError);
    }

    for (const id of [...this.parkedTrips]) {
      if (!openIds.has(id)) this.parkedTrips.delete(id);
    }
  }

  private async assessCostShapes(onError?: (label: string, error: unknown) => void): Promise<void> {
    const config = wardenConfig();
    for (const run of this.deps.liveRuns()) {
      await guarded(`costShape:${run.run}`, async () => {
        const trip = assessCostShape({ ...run.costShape, now: this.deps.now() }, config);
        if (!trip) return;
        const id = `${trip.key}:${trip.signal}`;
        if (this.parkedTrips.has(id)) return;
        const parked = await this.deps.actuator.park(run.run, trip.hint);
        if (!parked) {
          this.deps.journal.append({
            event: 'warden.health', actor: 'warden', key: run.run, signal: trip.signal, evidence: trip.hint,
          });
          return;
        }
        this.deps.journal.append({
          event: 'warden.parked', run: run.run, actor: 'warden', signal: trip.signal, evidence: trip.hint,
        });
        this.parkedTrips.add(id);
      }, onError);
    }
  }

  private async checkConformance(onError?: (label: string, error: unknown) => void): Promise<void> {
    if (!this.drift) return;
    for (const run of this.deps.liveRuns()) {
      if (!run.brief) continue;
      if (this.deps.dueForConformanceCheck && !this.deps.dueForConformanceCheck(run.run)) continue;
      const dod = extractDoD(run.brief);
      if (!dod) continue;
      await guarded(`conformanceDrift:${run.run}`, async () => {
        await this.drift!.check(run.run, dod, run.recentToolCalls);
      }, onError);
    }
  }

  private async resumeClearedCredentials(onError?: (label: string, error: unknown) => void): Promise<void> {
    if (!this.deps.credentialHorizon || !this.deps.openCredentialAccounts) return;
    for (const { account, probeValid } of this.deps.openCredentialAccounts()) {
      await guarded(`credentialHorizon:${account}`, async () => {
        await this.deps.credentialHorizon!.tick(account, probeValid);
      }, onError);
    }
  }
}

/**
 * B.9: the conformance drift cadence -- every 10 turns or every 5 minutes per run,
 * whichever comes first, in place of the "always due" default `WardenTickDeps` falls back
 * to when nothing tracks it. A run never checked before is due at once, which also seeds
 * the baseline the next call measures against.
 */
export class DriftCadenceTracker {
  private readonly lastChecked = new Map<string, { turns: number; at: number }>();

  constructor(private readonly turnInterval = 10, private readonly minMs = 5 * 60_000) {}

  isDue(run: string, turns: number, now: number): boolean {
    const last = this.lastChecked.get(run);
    if (!last) {
      this.lastChecked.set(run, { turns, at: now });
      return true;
    }
    const dueByTurns = turns - last.turns >= this.turnInterval;
    const dueByTime = now - last.at >= this.minMs;
    if (!dueByTurns && !dueByTime) return false;
    this.lastChecked.set(run, { turns, at: now });
    return true;
  }
}
