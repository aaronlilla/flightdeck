/**
 * What a gate does when the repository runs no checks of its own.
 *
 * An empty check rollup reads as `pending` (`council/gh.ts#conclusionOf`), and rightly:
 * seconds after a push, "no checks yet" and "no checks ever" look identical, and guessing
 * success there would merge on nothing. But a repository that runs none at all never
 * leaves that state, so the item polls twenty times and parks saying "checks never
 * settled" -- a sentence about a wait that never happened. Measured 2026-09-12: a real
 * ticket reached a draft pull request in this console's own repository, which has its
 * workflows disabled deliberately, and parked exactly that way.
 *
 * Aaron's decision, 2026-09-12: run the repository's own verify on the exact head and
 * treat that as the check. It is how he already merges there, and it keeps a real gate
 * rather than trading one away for an unattended loop.
 *
 * This module holds only the decision. Whether a repository has workflows, and how to run
 * its verify, are the caller's to supply -- so a specimen answers both without a network
 * or a shell, and an environment that wires neither keeps today's behaviour exactly.
 */

export interface NoCiGateDeps {
  /** Whether this repository runs any check on a pull request. Absent means the question
   *  was never wired, and the gate waits as it always did. */
  repoRunsChecks?: (repo: string) => Promise<boolean>;
  /** Runs the repository's own verify against the working tree the item holds. Absent
   *  means there is nothing to run in place of the checks. */
  runVerify?: (input: { repo: string; worktreePath: string }) => Promise<{ ok: boolean; output: string }>;
}

export type NoCiVerdict =
  /** Keep waiting: either the question is not wired, or the repository does run checks. */
  | { kind: 'wait' }
  /** The repository runs no checks and its own verify passed; treat the gate as green. */
  | { kind: 'passed'; why: string }
  /** The repository runs no checks and its own verify failed; park with what it said. */
  | { kind: 'failed'; why: string }
  /** The repository runs no checks and nothing here can run its verify. Park, and say
   *  that rather than claiming a wait timed out. */
  | { kind: 'cannot-check'; why: string };

/** The first line of output worth showing a person, trimmed. Verify output is long and a
 *  park reason is one line, so this takes the last non-empty line -- where a runner puts
 *  what failed -- rather than the first, which is the command echo. */
function lastMeaningfulLine(output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const last = lines[lines.length - 1] ?? '';
  return last.length > 160 ? `${last.slice(0, 157)}...` : last;
}

export async function noCiVerdict(
  input: { repo: string | null; worktreePath: string | null },
  deps: NoCiGateDeps,
): Promise<NoCiVerdict> {
  const { repo, worktreePath } = input;
  if (!repo || !deps.repoRunsChecks) return { kind: 'wait' };
  let runsChecks: boolean;
  try {
    runsChecks = await deps.repoRunsChecks(repo);
  } catch {
    // A failed lookup is not evidence that a repository runs nothing. Waiting is what the
    // gate did before this existed, and it never merges on a question it could not ask.
    return { kind: 'wait' };
  }
  if (runsChecks) return { kind: 'wait' };
  if (!deps.runVerify || !worktreePath) {
    return {
      kind: 'cannot-check',
      why: `${repo} runs no checks, and nothing here can run its own verify`,
    };
  }
  let result: { ok: boolean; output: string };
  try {
    result = await deps.runVerify({ repo, worktreePath });
  } catch (error) {
    return {
      kind: 'cannot-check',
      why: `${repo} runs no checks, and its verify could not be run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (result.ok) {
    return { kind: 'passed', why: `${repo} runs no checks; its own verify passed on this head` };
  }
  const tail = lastMeaningfulLine(result.output);
  return {
    kind: 'failed',
    why: tail
      ? `${repo} runs no checks; its own verify failed: ${tail}`
      : `${repo} runs no checks; its own verify failed`,
  };
}
