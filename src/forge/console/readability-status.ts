/**
 * The readability rule's own status, loud rather than fail-closed (item 4, R-59,
 * 2026-09-10): a machine with no `~/.forge/readability/contract.json` -- any machine
 * `install.ps1` has not run on -- never refuses a Jira comment or a PR write, it just
 * says so: once per console start in the journal (`readability.unconfigured`), and on
 * every `forge status` (`cli.ts`'s `status` case), so "the contract is unconfigured" is
 * a line an actual command prints rather than a fact sitting only in the raw journal.
 *
 * A dedicated Settings.tsx row (an `Integration`-shaped entry through the same
 * narration pipeline `integrations-narrate.ts` feeds) is not built in this change --
 * `forge status` is the observable surface here, not the console UI.
 */
import type { Journal } from '../journal.ts';
import { initReadabilityContract, type ContractLoadResult } from '../intake/readability.ts';

/** The exact sentence the Settings page renders for this row. */
export function readabilityStatusLine(state: ContractLoadResult): string {
  if (!state.ok) {
    return `Readability rule: not configured (no contract at ${state.dir})`;
  }
  const version = state.contract.contract_version;
  const versionSuffix = version ? `, version ${version.slice(0, 12)}` : '';
  return `Readability rule: on, ${state.contract.outward_repos.length} outward repo(s)${versionSuffix}`;
}

/**
 * Called once from `cli.ts`'s `up`: loads the contract (the one place it is read --
 * `readabilityVerdict` reuses this same cached result on every later call) and, only
 * when it is missing or malformed, journals one `readability.unconfigured` row. A
 * present contract journals nothing; the on-line itself is the only signal then.
 */
export function initReadabilityAndJournal(journal: Pick<Journal, 'append'>): ContractLoadResult {
  const state = initReadabilityContract();
  if (!state.ok) {
    journal.append({ event: 'readability.unconfigured', actor: 'console', dir: state.dir, reason: state.reason });
  }
  return state;
}
