/**
 * Whether the branch a run is working on still applies to its base.
 *
 * On 2026-09-04 `master` gained four commits under a forty-minute branch and nothing
 * noticed until a person ran `gh pr view` by hand. By then the branch had been pushed, a
 * pull request opened, and the conflict was a surprise at merge time rather than a fact
 * the run could have worked with.
 *
 * So the supervisor asks after every push and every pull request open, and a conflict
 * becomes a blocker in the inbox. Keyed by the base rather than by the run, because every
 * run behind that base is stuck on the same wall and one rebase clears them all.
 */
import type { Ask } from './inbox.js';

export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

/**
 * Read the mergeable state out of what `gh pr view --json mergeable` printed.
 *
 * Anything unreadable is UNKNOWN rather than MERGEABLE. `gh` not being installed, an
 * expired token and a rate limit all produce output that is not JSON, and treating those
 * as fine is how a branch gets pushed into a conflict nobody saw.
 */
export function readMergeable(output: string): Mergeable {
  try {
    const parsed = JSON.parse(output ?? '') as { mergeable?: string };
    if (parsed.mergeable === 'MERGEABLE') return 'MERGEABLE';
    if (parsed.mergeable === 'CONFLICTING') return 'CONFLICTING';
    return 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

/**
 * The blocker to raise for a mergeable state, or nothing when the branch still applies.
 *
 * The wording is the key, so it is deliberately the same sentence every time: two runs
 * behind one base raise one entry, and answering it once releases both.
 */
export function driftBlocker(run: string, state: Mergeable, base = 'the base branch'): Ask | undefined {
  if (state === 'MERGEABLE') return undefined;
  const because = state === 'CONFLICTING'
    ? `${base} has moved and this branch now conflicts with it`
    : `the mergeable state of this branch against ${base} could not be read, and unknown is not passing`;
  return {
    run,
    kind: 'blocker',
    question: `Base drift: ${because}. Rebase onto ${base} and resolve, or say what to do instead.`,
    options: ['rebase and continue', 'stop and leave it for review'],
  };
}

/**
 * `now()`/`sleep()`, injected so a specimen can drive the retry window below without a
 * real wait (I16's own falsifier: "the retry sleeps for real in the specimen").
 * Production gets the real clock; a fake advances its own virtual clock on `sleep`
 * instead of actually waiting.
 */
export interface DriftClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const REAL_DRIFT_CLOCK: DriftClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * GitHub computes a pull request's mergeable state asynchronously after it is created
 * (and after a push moves it), so the read right after a push or a PR open is routinely
 * UNKNOWN for a branch that is perfectly fine (I16, C2 run 8: the drift check raised a
 * blocker for a PR that was twelve seconds old). Retrying gives that computation a
 * chance to finish before treating the run as stuck.
 *
 * A confirmed CONFLICTING state raises at once -- there is nothing to wait for, the
 * branch already lost. An UNKNOWN state is retried every `intervalMs` until either a
 * definite answer arrives or `windowMs` has passed, at which point the last read
 * (MERGEABLE, CONFLICTING or still UNKNOWN) is returned as-is.
 */
export async function resolveMergeable(
  check: () => Promise<Mergeable>,
  clock: DriftClock = REAL_DRIFT_CLOCK,
  intervalMs = 10_000,
  windowMs = 90_000,
): Promise<Mergeable> {
  const deadline = clock.now() + windowMs;
  let state = await check();
  while (state === 'UNKNOWN' && clock.now() < deadline) {
    await clock.sleep(intervalMs);
    state = await check();
  }
  return state;
}
