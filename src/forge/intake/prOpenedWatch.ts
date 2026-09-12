/**
 * Fire the ticket move automatically, the moment a worker opens a pull request.
 *
 * `runPrOpenedHandoff` was invocable by hand and nothing called it, so a pull request
 * opened by a worker still left its ticket reading Backlog -- the exact board-lies defect
 * the command was written to stop, one step removed.
 *
 * This is the piece between the two: given the checkout a `gh pr create` ran in, read the
 * pull request that now exists for that branch and run the handoff against it. It reads
 * the pull request rather than parsing the command, because `gh pr create` takes its title
 * from a flag, a file, an editor or the commit message, and only one of those is on the
 * command line.
 *
 * Everything is injected. Nothing here reaches for a real `gh` or a real tracker, so the
 * whole path is exercised by a specimen.
 */
import { runPrOpenedHandoff, type PrOpenedEnv, type PrOpenedEvent, type PrOpenedResult } from './prOpened.js';
import type { JiraWriteClient } from './jira.js';

export interface OpenedPullRequest {
  number: number;
  title: string;
  url: string;
}

export interface PrOpenedWatchDeps {
  /** The pull request that now exists for the branch checked out at `cwd`, or null when
   *  there is none to read (the create failed, or the output named nothing). */
  readPrAt(cwd: string): Promise<OpenedPullRequest | null>;
  /** The tracker write client, or null when no credentials are configured. */
  client(): JiraWriteClient | null;
  env(): PrOpenedEnv;
  emit(event: PrOpenedEvent | { event: 'pr-opened.skipped'; prUrl: string; body: string }): void;
}

/**
 * Runs the handoff for whatever pull request now exists at `cwd`. Never throws: this is
 * called fire-and-forget off a tool-result in the turn stream, and an exception escaping
 * here would take the worker's own turn with it. Every reason for doing nothing is
 * emitted rather than swallowed, so a ticket that did not move says why.
 */
export async function handlePullRequestOpened(
  cwd: string,
  deps: PrOpenedWatchDeps,
): Promise<PrOpenedResult | null> {
  let pr: OpenedPullRequest | null;
  try {
    pr = await deps.readPrAt(cwd);
  } catch (err) {
    deps.emit({
      event: 'pr-opened.skipped',
      prUrl: '',
      body: `could not read the pull request at ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return null;
  }
  if (!pr) {
    deps.emit({ event: 'pr-opened.skipped', prUrl: '', body: `no pull request found at ${cwd}` });
    return null;
  }

  const client = deps.client();
  if (!client) {
    deps.emit({ event: 'pr-opened.skipped', prUrl: pr.url, body: 'no tracker credentials configured' });
    return null;
  }

  try {
    return await runPrOpenedHandoff(client, { prUrl: pr.url, title: pr.title }, deps.env(), deps.emit);
  } catch (err) {
    deps.emit({
      event: 'pr-opened.skipped',
      prUrl: pr.url,
      body: `the handoff threw: ${err instanceof Error ? err.message : String(err)}`,
    });
    return null;
  }
}

/**
 * The real reader: asks GitHub for the pull request belonging to whatever branch is
 * checked out at `cwd`. `gh pr view` with no argument resolves it from the branch, which
 * is why the checkout is all this needs -- `gh pr create` takes its title from a flag, a
 * file, an editor or the commit message, and only one of those is on the command line.
 *
 * Returns null rather than throwing when there is nothing to read, so an ordinary "no
 * pull request here" is not reported as a failure.
 */
export function readPrAtCheckout(
  execRun: (args: { argv: string[]; cwd: string; owner: string; cls: string; fullOutput: boolean })
    => Promise<{ returncode?: number | null; full?: string; tail: string }>,
): (cwd: string) => Promise<OpenedPullRequest | null> {
  return async (cwd) => {
    const view = await execRun({
      argv: ['gh', 'pr', 'view', '--json', 'number,title,url'],
      cwd,
      owner: 'pr-opened',
      cls: 'script',
      fullOutput: true,
    });
    if (view.returncode !== 0) return null;
    const text = view.full ?? view.tail;
    let parsed: { number?: number; title?: string; url?: string };
    try {
      parsed = JSON.parse(text) as { number?: number; title?: string; url?: string };
    } catch {
      return null;
    }
    if (typeof parsed.number !== 'number' || typeof parsed.url !== 'string') return null;
    return { number: parsed.number, title: parsed.title ?? '', url: parsed.url };
  };
}
