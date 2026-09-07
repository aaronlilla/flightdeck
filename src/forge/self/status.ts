/**
 * F.5: `selfStatus()`, for `/state`. A read of the two logs this stream already keeps --
 * the findings ledger and the intake queue's own store -- folded to the four numbers a
 * dashboard needs, never a new source of truth of its own.
 */
import type { QueueStore } from '../intake/queueStore.js';
import { QUEUE_IN_FLIGHT_STATES } from '../intake/queue.js';
import type { FindingsLedger } from './ledger.js';

export interface SelfStatus {
  findingsTotal: number;
  /** Self-repo queue items currently `queued`/`planning`/`running`. */
  queued: number;
  /** Self-repo queue items that reached `done`. */
  merged: number;
  /** The most recent `at` across every finding on the ledger, or `null` for an empty
   *  one -- never `0`, which would read as a real timestamp in 1970. */
  lastAnalysisAt: number | null;
}

export function selfStatus(ledger: FindingsLedger, store: QueueStore, selfRepo: string): SelfStatus {
  const findings = ledger.all();
  const selfItems = store.all().filter((item) => item.repo === selfRepo);
  return {
    findingsTotal: findings.length,
    queued: selfItems.filter((item) => QUEUE_IN_FLIGHT_STATES.includes(item.state)).length,
    merged: selfItems.filter((item) => item.state === 'done').length,
    lastAnalysisAt: findings.length === 0 ? null : Math.max(...findings.map((f) => f.at)),
  };
}
