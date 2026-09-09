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
 * B.5: why a mergeable read came back UNKNOWN, when it is readable at all -- distinct from
 * a genuinely undecided state (GitHub still computing it right after a push or a PR open,
 * `resolveMergeable`'s own retry window below) from a `gh` call that never got a real
 * answer at all. `auth` and `rate-limit` are both a credential lapse, not a base-drift
 * problem the branch itself did anything to cause, and both auto-clear once `gh auth
 * status` passes again -- so a caller with `CredentialHorizon` wired up (`credential-
 * horizon.ts`) can park the run behind that instead of raising a base-drift blocker no
 * rebase will ever answer.
 */
export type UnknownReason = 'auth' | 'rate-limit' | 'other';

const AUTH_PATTERNS = [
  /not logged into any github hosts/i, /gh auth login/i, /authentication/i,
  /bad credentials/i, /401/,
];
const RATE_LIMIT_PATTERNS = [/rate limit/i, /403/];

export function classifyUnknown(output: string): UnknownReason {
  if (AUTH_PATTERNS.some((pattern) => pattern.test(output))) return 'auth';
  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(output))) return 'rate-limit';
  return 'other';
}

export interface MergeableRead {
  state: Mergeable;
  /** Only set when `state` is UNKNOWN for a classifiable reason -- an ordinary
   *  still-computing UNKNOWN carries none, since there is nothing to classify. */
  reason?: Exclude<UnknownReason, 'other'>;
  /** Exactly what the `gh` call printed, so a caller raising an ask can quote the
   *  failure a person has to act on rather than describe it second-hand. Redact it
   *  before it leaves the process: `gh` prints tokens in some error URLs. */
  output?: string;
  /** The pull request's own base branch, read off the same `gh` call. Undefined when the
   *  call never produced one -- an unreadable base is said out loud, never guessed at. */
  base?: string;
}

/** `readMergeable` plus the reason, when the output itself explains the failure rather
 *  than the state genuinely being undecided, plus the base branch and the raw output. */
export function readMergeableDetailed(output: string): MergeableRead {
  const text = output ?? '';
  const state = readMergeable(text);
  const base = readBaseRef(text);
  const withBase = base === undefined ? {} : { base };
  if (state !== 'UNKNOWN') return { state, output: text, ...withBase };
  // Only output that is not an answer gets classified. `gh` reporting
  // `{"mergeable":"UNKNOWN"}` has answered: the state is undecided while GitHub computes
  // it, and there is no failure to explain. Running the patterns over a successful
  // payload reads the branch name as an error message, so a pull request based on
  // `release/403-hotfix` came back as a rate limit and a run was sent to the credential
  // horizon over a branch name.
  const reason = answeredMergeable(text) ? 'other' : classifyUnknown(text);
  return reason === 'other'
    ? { state, output: text, ...withBase }
    : { state, reason, output: text, ...withBase };
}

/** Whether `gh` answered the question at all, whatever the answer was. */
function answeredMergeable(output: string): boolean {
  try {
    const parsed = JSON.parse(output ?? '') as { mergeable?: unknown };
    return typeof parsed?.mergeable === 'string';
  } catch {
    return false;
  }
}

/**
 * The ask a credential lapse raises, so a person has something to answer.
 *
 * `CredentialHorizon` parks under `credential:<account>` and clears on `tick()`, which
 * nothing in the shipped binary calls yet, so a park on its own is a wall with no door.
 * This entry is the door. It names the credential and the thing that fixes it, and it
 * never mentions rebasing: no rebase has ever cleared an expired token.
 *
 * Keyed on wording like every other blocker, so several runs behind one lapsed account
 * share one entry and one answer releases all of them.
 */
export function credentialBlocker(run: string, account: string, reason: 'auth' | 'rate-limit'): Ask {
  const because = reason === 'auth'
    ? `the ${account} credential is not logged in`
    : `the ${account} credential is over its rate limit`;
  return {
    run,
    kind: 'blocker',
    question: `Credential lapse: ${because}, so the branch cannot be checked against its `
      + `base. Reconnect ${account} on the console's Integrations panel, then answer this `
      + 'to carry on.',
    options: ['reconnected, continue', 'stop and leave it for review'],
  };
}

/**
 * The base branch `gh pr view --json ...,baseRefName` reported, when it reported one.
 *
 * Undefined for output that is not JSON, carries no `baseRefName`, or carries an empty
 * one: a base nobody could read is named as unreadable, never defaulted to `main`. A
 * guessed base in a question is worse than no base, because it reads as a fact.
 */
export function readBaseRef(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output ?? '') as { baseRefName?: unknown };
    const base = parsed.baseRefName;
    if (typeof base !== 'string') return undefined;
    const trimmed = base.trim();
    return trimmed === '' ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

export type DriftOutcome =
  | { kind: 'clear' }
  | { kind: 'credential-lapse'; account: string; reason: 'auth' | 'rate-limit' }
  | { kind: 'blocker'; ask: Ask };

/**
 * The full drift decision for one read: MERGEABLE clears, an auth or rate-limit UNKNOWN is
 * a credential lapse rather than a blocker, and everything else is `driftBlocker` as
 * before. `ghAccount` names the credential a caller's `CredentialHorizon` should park
 * behind; the queue's own `gh` account, by default.
 */
export function classifyDrift(
  run: string, output: string, base = 'the base branch', ghAccount = 'gh',
): DriftOutcome {
  const read = readMergeableDetailed(output);
  // The explicit `base` argument wins over anything the output happened to name: this
  // overload's callers pass the base they already know, and its default is the literal
  // no-branch wording.
  return classifyDriftRead(run, { ...read, base }, ghAccount);
}

/**
 * `classifyDrift` for a read that has already happened -- the shape the engine's retry
 * window returns, so the reason and the base survive the wait instead of being re-derived
 * from output the caller may not have (a specimen driving `checkDrift` returns a state,
 * not `gh` text).
 *
 * The base named in the question is the one the read itself reported. When the read
 * reported none, `driftBlocker`'s own no-branch wording stands: an unreadable base is
 * said as unreadable, never filled in with a guess.
 */
export function classifyDriftRead(
  run: string, read: MergeableRead, ghAccount = 'gh',
): DriftOutcome {
  const { state, reason, base } = read;
  if (state === 'MERGEABLE') return { kind: 'clear' };
  if (reason === 'auth' || reason === 'rate-limit') {
    return { kind: 'credential-lapse', account: ghAccount, reason };
  }
  const ask = base === undefined ? driftBlocker(run, state) : driftBlocker(run, state, base);
  // driftBlocker only returns undefined for MERGEABLE, already handled above, but the
  // type still allows it -- fall back to a blocker rather than silently clearing.
  const named = base ?? 'the base branch';
  return { kind: 'blocker', ask: ask ?? { run, kind: 'blocker', question: `Base drift against ${named}: unknown state.`, options: ['rebase and continue', 'stop and leave it for review'] } };
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

/**
 * `resolveMergeable` for a read that carries its own reason.
 *
 * The retry window exists for GitHub still computing a mergeable state after a push, and
 * that is the only UNKNOWN worth waiting on. An UNKNOWN whose output already says why --
 * an expired token, a rate limit -- is a definite answer arriving early: waiting ninety
 * seconds for it to change is ninety seconds a run spends learning nothing, and the
 * answer at the end is the same one it had at the start.
 */
export async function resolveMergeableRead(
  check: () => Promise<MergeableRead>,
  clock: DriftClock = REAL_DRIFT_CLOCK,
  intervalMs = 10_000,
  windowMs = 90_000,
): Promise<MergeableRead> {
  const deadline = clock.now() + windowMs;
  let read = await check();
  while (read.state === 'UNKNOWN' && read.reason === undefined && clock.now() < deadline) {
    await clock.sleep(intervalMs);
    read = await check();
  }
  return read;
}
