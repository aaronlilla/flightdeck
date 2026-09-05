/**
 * `fleet-unknown` is a probe failure, not a run's fault. Order 6 (sensor validity): a
 * failed process-list probe and a verified empty fleet must never look the same, but a
 * broken sensor is also never treated as evidence against any particular run. So this is
 * reported and nothing else: no actuator reaches this function's parameters at all,
 * which is what makes "never acted on" a property of the code rather than a promise a
 * caller has to keep.
 */
import type { ExtendedStuckSignal } from './contracts.js';
import type { Journal } from './journal.js';

/**
 * Journal a `warden.health` row for every open `fleet-unknown` trip. Takes no actuator,
 * on purpose: there is nothing here for a caller to accidentally wire a park or a kill
 * into.
 */
export function reportFleetHealth(journal: Journal, stuck: ExtendedStuckSignal[]): number {
  const trips = stuck.filter((trip) => trip.signal === 'fleet-unknown');
  for (const trip of trips) {
    journal.append({ event: 'warden.health', actor: 'warden', signal: trip.signal, hint: trip.hint });
  }
  return trips.length;
}
