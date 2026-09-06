// Live-proof helper: forces a run's lane into `blocked` the exact way liveness.ts's own
// stuck-session signal does (`this.actuator.lanes.put(trip.key, { needs_aaron: trip.hint })`,
// liveness.ts:276), without waiting out the real idle threshold. Reads FORGE_HOME from the
// environment so it always points at the same throwaway home the server under test is
// running against.
import { Lanes } from '../../src/forge/supervisor.js';
import { lanesDir } from '../../src/forge/paths.js';

const run = process.argv[2];
if (!run) {
  console.error('usage: force-blocked.mjs <run>');
  process.exit(2);
}
const lanes = new Lanes(lanesDir());
lanes.put(run, { needs_aaron: 'stuck-session signal (forced for a live proof)' });
console.log(`forced ${run} blocked via lanes.put(needs_aaron=...)`);
