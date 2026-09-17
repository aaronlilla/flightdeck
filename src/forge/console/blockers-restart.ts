/**
 * `buildRestarters`: what resumes once a blocker's chain clears.
 *
 * `question` restarts nothing (answering it already resumes whatever it parked); every
 * other kind shares one restart: a parked queue item retries through the queue's own
 * `retryItem` (`intake/queue.ts`, the same path `POST /queue/:id/retry` drives), a parked
 * run with no queue item resumes through the injected `resumeRun`, and a lane already
 * running is left alone. `blockers-route.ts` journals the `blocker.cleared` row itself;
 * this module's own job is the restart and one rail receipt in words for whatever it
 * actually started.
 */
import { retryItem } from '../intake/queue.js';
import type { QueueStore } from '../intake/queueStore.js';
import type { Blocker, BlockerKind, LanesResponse } from '../../shared/console-model.js';
import type { Restarter } from './blockers-route.js';

export interface BlockersRestartDeps {
  queueStore: QueueStore;
  lanesView: () => LanesResponse;
  /** Resumes a plain (non-queue) parked run -- production wires this to `resumeRun`
   *  (`run-actions.ts`) against the console's own `RunActionsDeps`. A specimen never
   *  drives the real actuator. */
  resumeRun: (laneId: string) => Promise<{ ok: boolean }>;
  /** The console's own thread writer (`command.ts`'s `appendThread`), turned into a
   *  plain-text receipt card here rather than this module reaching for `Message` shapes
   *  itself. */
  appendReceipt: (text: string) => void;
}

async function restartOne(laneId: string, deps: BlockersRestartDeps): Promise<boolean> {
  const view = deps.lanesView();
  const lane = view.lanes.find((l) => l.id === laneId);
  if (lane && (lane.state === 'running' || lane.state === 'handed-off')) return false;

  const item = deps.queueStore.all().find((row) => row.runKey === laneId);
  if (item && (item.state === 'parked' || item.state === 'failed')) {
    // A person said "I did it" on the blocker, so this is a person's retry and the
    // item gets its recovery budgets back. Without the flag the click restarts an item
    // whose read budget is already spent, and the recovery pass declines on the first
    // tick without a row: the click does nothing and says nothing.
    return Boolean(retryItem(deps.queueStore, item.id, Date.now(), { askedByAPerson: true }));
  }

  const outcome = await deps.resumeRun(laneId);
  return outcome.ok;
}

function labelFor(blocker: Blocker, laneId: string): string {
  return blocker.blocks.find((b) => b.laneId === laneId)?.label ?? laneId;
}

function makeRestarter(deps: BlockersRestartDeps): Restarter {
  return async (blocker: Blocker, laneIds: string[]): Promise<string[]> => {
    const started: string[] = [];
    for (const laneId of laneIds) {
      if (await restartOne(laneId, deps)) started.push(laneId);
    }
    if (started.length) {
      const labels = started.map((id) => labelFor(blocker, id));
      deps.appendReceipt(`Restarted ${labels.join(', ')} after "${blocker.title}" cleared.`);
    }
    return started;
  };
}

/** One `Restarter` per `BlockerKind` that actually restarts something -- `question`
 *  carries none, per `blockers-route.ts`'s own contract: a kind with nothing wired here
 *  restarts nothing and says so honestly, never a silent no-op pretending to have acted. */
export function buildRestarters(deps: BlockersRestartDeps): Partial<Record<BlockerKind, Restarter>> {
  const restart = makeRestarter(deps);
  return {
    integration: restart,
    process: restart,
    checks: restart,
    billing: restart,
  };
}
