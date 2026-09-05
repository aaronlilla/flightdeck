/**
 * Dispatcher decision 2: a canary is the proposal's diff applied in a throwaway
 * worktree, `npm run verify` run there, then the live probe brief run through that
 * worktree's `forge run` with `FORGE_HOME` at a temporary directory. It passes when the
 * journal ends `done` with zero successors and the same decisive rows as the golden run
 * recorded in the corpus manifest.
 *
 * "In this stream the canary is a function with a fake runner; the live canary is the
 * dispatcher's probe" -- every dependency below is injected, and no specimen for this
 * module ever spawns `npm`, `git worktree`, or a real SDK session (zero-spend rule).
 */
import type { ForgeEventEnvelope } from '../contracts.js';

export interface CanaryDeps {
  applyDiffInWorktree(): Promise<{ worktreeDir: string }>;
  runVerify(worktreeDir: string): Promise<{ exitCode: number }>;
  runProbe(worktreeDir: string): Promise<{ events: ForgeEventEnvelope[] }>;
}

export interface GoldenRun {
  /** The event names, in order, this run is expected to reproduce -- the "decisive rows"
   *  the dispatcher's decision names, recorded once against the corpus's own golden run. */
  decisiveEvents: string[];
}

export type CanaryResult =
  | { passed: true }
  | { passed: false; reason: string };

function terminalRunEvents(events: ForgeEventEnvelope[]): ForgeEventEnvelope[] {
  return events.filter((event) => event.event === 'run.finished' || event.event === 'run.blocked' || event.event === 'run.parked');
}

/**
 * "Ends done with zero successors": the last run-lifecycle-relevant event must be a
 * `run.finished` row, and nothing after it in the stream may carry the same `run` id --
 * a `run.parked` or a second `run.finished` after the first is not "done", it is "done,
 * then something else happened", and that is a canary failure, not a pass with a footnote.
 */
export function endsDoneWithNoSuccessors(events: ForgeEventEnvelope[]): boolean {
  const terminal = terminalRunEvents(events);
  const last = terminal[terminal.length - 1];
  if (!last || last.event !== 'run.finished') return false;
  const lastIndex = events.indexOf(last);
  return !events.slice(lastIndex + 1).some((event) => event.run === last.run);
}

export function matchesDecisiveRows(events: ForgeEventEnvelope[], golden: GoldenRun): boolean {
  const seen = events.map((event) => event.event as string);
  let cursor = 0;
  for (const wanted of golden.decisiveEvents) {
    const found = seen.indexOf(wanted, cursor);
    if (found === -1) return false;
    cursor = found + 1;
  }
  return true;
}

export async function runCanary(deps: CanaryDeps, golden: GoldenRun): Promise<CanaryResult> {
  const { worktreeDir } = await deps.applyDiffInWorktree();

  const verifyResult = await deps.runVerify(worktreeDir);
  if (verifyResult.exitCode !== 0) {
    return { passed: false, reason: `npm run verify exited ${verifyResult.exitCode} in the canary worktree` };
  }

  const probe = await deps.runProbe(worktreeDir);
  if (!endsDoneWithNoSuccessors(probe.events)) {
    return { passed: false, reason: 'the probe journal did not end done with zero successors' };
  }
  if (!matchesDecisiveRows(probe.events, golden)) {
    return { passed: false, reason: 'the probe journal is missing one of the golden run\'s decisive rows' };
  }

  return { passed: true };
}
