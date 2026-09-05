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
}

/** Signals `assess()` can raise that name a run and are safe for a generic actuator park.
 *  `fleet-unknown` names the probe, not a run (`reportFleetHealth`'s own job, never
 *  acted on); `drift` and `blocker` already parked themselves the moment they were
 *  raised (`ConformanceDrift.check`, `BlockerBoard.raise`), so parking them again here
 *  would be a second, redundant park record for the same trip. */
const GENERIC_PARK_SIGNALS = new Set([
  'idle', 'tool-budget', 'context', 'stale-session', 'login-stuck',
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
    await this.assessCostShapes(onError);
    await this.checkConformance(onError);
    await this.resumeClearedCredentials(onError);
  }

  private async parkGenericTrips(onError?: (label: string, error: unknown) => void): Promise<void> {
    const open = this.deps.stuck().filter((trip) => GENERIC_PARK_SIGNALS.has(trip.signal));
    const openIds = new Set(open.map((trip) => `${trip.key}:${trip.signal}`));

    for (const trip of open) {
      const id = `${trip.key}:${trip.signal}`;
      if (this.parkedTrips.has(id)) continue;
      await guarded(`park:${id}`, async () => {
        await this.deps.actuator.park(trip.key, trip.hint);
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
        await this.deps.actuator.park(run.run, trip.hint);
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
