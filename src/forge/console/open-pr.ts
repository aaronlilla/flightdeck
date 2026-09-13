/**
 * Opening a pull request from the console.
 *
 * The only `gh pr create` in this codebase runs inside a worker's own turn
 * (`sdkengine.ts`), so a branch a worker pushed and then stopped short of could only
 * become a pull request from a terminal. That is one of the four actions the board could
 * not finish on a screen (Aaron, 2026-09-13).
 *
 * The refusals are most of this module, and deliberately so. Every one of them is a thing
 * that would otherwise be discovered by GitHub rejecting the call in language that names
 * neither the branch nor what to do about it -- or worse, by Joe opening a pull request
 * whose body breaks the rule he asked for. Each refusal says which it is, by name, and
 * opens nothing.
 */

/** What the console knows about the lane a request would be opened for. */
export interface OpenPrLane {
  repo: string | null;
  branch: string | null;
  base: string | null;
  ticket: string | null;
}

export interface OpenPrResult {
  ok: boolean;
  /** Set on success, and also when the refusal is "one already exists" -- that request
   *  is the useful thing to hand back, not an error. */
  number: number | null;
  url: string | null;
  /** Empty when the request was opened. Otherwise the sentence saying why it was not. */
  refused: string;
  /** The readability rule's advice when it advised rather than denied. Carried rather
   *  than swallowed: it is the difference between a body that ships and one that should
   *  be trimmed first, and nobody sees it if this drops it. */
  advice: string;
}

export interface OpenPrDeps {
  lane: (run: string) => OpenPrLane | null;
  /** Does this branch exist on the remote? A branch with no commits pushed cannot carry
   *  a pull request, and GitHub's own refusal for it names neither the branch nor the fix. */
  pushed: (repo: string, branch: string) => Promise<boolean>;
  /** The request already open on this branch, or null. */
  existing: (repo: string, branch: string) => Promise<{ number: number; url: string } | null>;
  create: (input: {
    repo: string; branch: string; base: string; title: string; body: string; draft: boolean;
  }) => Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }>;
  /** The same rule the guard applies to a pull request body, run here so a body that
   *  would be denied is refused BEFORE the request exists, rather than after. */
  readability: (repo: string, title: string, body: string) => { verdict: string; reason: string };
}

export async function openPullRequest(
  run: string, title: string, body: string, deps: OpenPrDeps,
  options: { draft?: boolean } = {},
): Promise<OpenPrResult> {
  const no = (refused: string, found?: { number: number; url: string }): OpenPrResult => ({
    ok: false, number: found?.number ?? null, url: found?.url ?? null, refused, advice: '',
  });

  const lane = deps.lane(run);
  if (!lane) return no(`there is no lane called "${run}" here, so there is nothing to open a request for`);
  if (!lane.repo) return no(`${run} has no repository on record, so there is nowhere to open a request`);
  if (!lane.branch) return no(`${run} has no branch on record; a request needs one to open from`);

  const heading = title.trim();
  if (!heading) return no('a pull request needs a title; this one is empty');
  const text = body.trim();
  if (!text) return no('a pull request needs a body describing what breaks and what changes');

  const { repo, branch } = lane;
  const base = lane.base ?? 'develop';

  // Before anything else that costs a round trip: the rule Joe asked for. A body that
  // would be denied is refused here, where it is still a draft on a screen, rather than
  // opened and then rejected with the request already sitting there for him to read.
  // ADVISE is not DENY -- the rule advises below a line and denies above it, and
  // treating them alike would refuse work the rule deliberately lets through.
  const verdict = deps.readability(repo, heading, text);
  if (verdict.verdict === 'DENY') {
    return no(`the body breaks the rule for anything a teammate reads: ${verdict.reason}`);
  }
  const advice = verdict.verdict === 'ADVISE' ? verdict.reason : '';

  try {
    if (!(await deps.pushed(repo, branch))) {
      return no(`${branch} is not on the remote yet, so there is nothing to open a request from -- push it first`);
    }

    const already = await deps.existing(repo, branch);
    if (already) {
      return no(`${branch} already has an open pull request`, already);
    }

    const made = await deps.create({
      repo, branch, base, title: heading, body: text, draft: options.draft ?? false,
    });
    if (!made.ok) return no(made.error.slice(0, 400));
    return { ok: true, number: made.number, url: made.url, refused: '', advice };
  } catch (error) {
    // A throw from `gh` -- not installed, not authenticated, a killed process -- must not
    // escape and leave the caller with no answer at all. The handoff route learned this
    // from a rejected fetch; the same rule applies to a spawned command.
    return no(error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400));
  }
}

/**
 * The real `gh` calls, built on the same `execRun` every other command in this codebase
 * goes through. Kept beside the rules rather than inside them so the rules can be proven
 * without a network, a checkout, or `gh` being installed.
 */
export function realOpenPrDeps(
  execRun: (input: { argv: string[]; cwd: string; owner: string; cls: string }) =>
    Promise<{ ok: boolean; tail: string }>,
  lane: OpenPrDeps['lane'],
  readability: OpenPrDeps['readability'],
): OpenPrDeps {
  const gh = (argv: string[]) => execRun({ argv, cwd: process.cwd(), owner: 'console-open-pr', cls: 'script' });
  return {
    lane,
    readability,
    async pushed(repo, branch) {
      // The remote's own answer, not a local ref: a branch deleted on the remote still
      // has a local tracking ref, and opening from one of those fails at GitHub with a
      // message that names neither.
      const result = await gh(['gh', 'api', `repos/${repo}/branches/${branch}`, '--jq', '.name']);
      return result.ok && result.tail.trim() === branch;
    },
    async existing(repo, branch) {
      const result = await gh(['gh', 'pr', 'list', '--repo', repo, '--head', branch,
                               '--state', 'open', '--json', 'number,url']);
      if (!result.ok) return null;
      try {
        const rows = JSON.parse(result.tail) as { number: number; url: string }[];
        return rows[0] ?? null;
      } catch {
        return null;
      }
    },
    async create({ repo, branch, base, title, body, draft }) {
      const argv = ['gh', 'pr', 'create', '--repo', repo, '--head', branch, '--base', base,
                    '--title', title, '--body', body];
      if (draft) argv.push('--draft');
      const result = await gh(argv);
      if (!result.ok) return { ok: false as const, error: result.tail.trim() || 'gh pr create failed with no output' };
      // `gh pr create` prints the URL of what it made, and the number is its last segment.
      const url = (result.tail.match(/https:\/\/\S*\/pull\/\d+/) ?? [])[0];
      const number = url ? Number(url.split('/').pop()) : NaN;
      if (!url || !Number.isFinite(number)) {
        return { ok: false as const, error: `gh pr create said nothing this could read a URL out of: ${result.tail.trim().slice(0, 200)}` };
      }
      return { ok: true as const, number, url };
    },
  };
}
