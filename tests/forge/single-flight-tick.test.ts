/**
 * `SingleFlightTick` (`src/forge/single-flight-tick.ts`): the guard that stops the 30s
 * Warden/liveness tick in `cli.ts` from overlapping itself, copied from
 * `QueueTickRunner`'s own `running` flag (`intake/queueTickRunner.ts:125-126,154`).
 */
import { describe, expect, it } from 'vitest';

import { SingleFlightTick } from '../../src/forge/single-flight-tick.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('SingleFlightTick', () => {
  it('a second tick() while the first pass is still running is a no-op: the pass runs once, not twice', async () => {
    const gate = deferred<void>();
    let starts = 0;
    const guard = new SingleFlightTick(async () => {
      starts += 1;
      await gate.promise;
    });

    guard.tick();
    guard.tick();
    guard.tick();
    expect(starts).toBe(1);
    expect(guard.inFlight).toBe(true);

    gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(guard.inFlight).toBe(false);
  });

  it('a tick() after the previous pass settled starts a fresh pass', async () => {
    let starts = 0;
    const guard = new SingleFlightTick(async () => { starts += 1; });

    guard.tick();
    await new Promise((resolve) => setImmediate(resolve));
    guard.tick();
    await new Promise((resolve) => setImmediate(resolve));

    expect(starts).toBe(2);
  });

  it('a rejecting pass never throws out of tick() and still clears inFlight for the next one', async () => {
    let starts = 0;
    const guard = new SingleFlightTick(async () => {
      starts += 1;
      throw new Error('boom');
    });

    expect(() => guard.tick()).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(guard.inFlight).toBe(false);

    guard.tick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(starts).toBe(2);
  });
});
