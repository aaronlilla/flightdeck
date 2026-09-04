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
