/**
 * Order 19 (READABLE BY JOE), applied to Council's proposed actions and to the worker's
 * own PreToolUse hook. Reuses `readabilityVerdict` (`intake/readability.ts`) rather than
 * re-deriving the contract a second time -- the contract is installed to this machine and
 * loaded once, the same shape both this rule and the operator's own authorship hook read.
 *
 * A structured `'pr'` action (Council's merge gate, `cli.ts`) already carries a real
 * `repo`/`title`/`body`; a `'bash'` action (the worker's own `gh pr create`/`comment`/
 * `edit` or `git commit -m`) carries only the raw shell command line, so this rule parses
 * the `--title`, `--body` and `--body-file` flags out of it before calling the same
 * verdict function -- the worker never gets a free pass just because its write goes out
 * as a shell command instead of a typed call.
 */
import { readFileSync } from 'node:fs';
import { deny, allow } from './types.ts';
import type { ProposedAction, RuleVerdict } from './types.ts';
import { readabilityVerdict, getReadabilityContractState, repoNameFrom } from '../intake/readability.ts';

const RULE_NAME = 'readability';

interface ParsedGh {
  surface: 'pr-title' | 'pr-body' | 'pr-comment';
  repo: string | null;
  title: string;
  body: string;
}

/** A shell argument value -- double-quoted, single-quoted, or bare (a `--repo owner/name`
 *  has no reason to be quoted, having no spaces), unescaped just enough to read the text a
 *  human would see. This rule only needs the prose, never a faithful shell parse. */
function argValue(command: string, flag: string): string | null {
  const re = new RegExp(
    `${flag}\\s+"((?:[^"\\\\]|\\\\.)*)"|${flag}\\s+'((?:[^'\\\\]|\\\\.)*)'|${flag}\\s+(\\S+)`,
  );
  const m = re.exec(command);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(["'])/g, '$1');
}

/** The contract's `outward_repos` holds bare repo names, but every real caller -- the
 *  worker's own `gh --repo owner/name`, cli.ts's merge gate, queue.ts's routed
 *  `item.repo` -- carries an `owner/name` slug or a path. Strip everything up to the
 *  last `/` before comparing, or the outward-repo check silently never matches and every
 *  gate downstream of it is a no-op (G3, 2026-09-10: confirmed empirically). */
export function normalizeRepo(repo: string | null | undefined): string | null {
  if (!repo) return null;
  const last = repo.replace(/\\/g, '/').split('/').filter(Boolean).pop();
  return last ? last.toLowerCase() : null;
}

function repoFromCommand(command: string, cwd: string): string | null {
  const flagged = argValue(command, '--repo');
  if (flagged) return normalizeRepo(flagged);
  // `repoNameFrom` rather than a strip written here: this stripped `^.*--`, which on a
  // worktree named `<repo>--<slug>` returns the SLUG. The slug is in no contract's
  // `outward_repos`, so every check below went quiet for all work done in a worktree --
  // which is where all of it is done. Found by a review on 2026-09-12, in the function
  // whose own comment warns that a failed repo match makes every gate a no-op.
  return repoNameFrom(cwd);
}

/** `null` when the command is not a `gh pr create|comment|edit` this rule has an
 *  opinion on -- `evaluate()` allows those outright rather than guessing. */
function parseGhCommand(command: string, cwd: string): ParsedGh | null {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== 'gh' || tokens[1] !== 'pr') return null;
  const op = tokens[2];
  if (op !== 'create' && op !== 'comment' && op !== 'edit') return null;

  const bodyFile = argValue(command, '--body-file');
  let body = argValue(command, '--body') ?? '';
  if (!body && bodyFile && bodyFile !== '-') {
    try {
      body = readFileSync(bodyFile, 'utf8');
    } catch {
      // Unreadable body file: fall through with an empty body rather than throwing out
      // of a permission hook -- a missing file surfaces its own error at the real `gh`
      // call, not here.
    }
  }
  const title = argValue(command, '--title') ?? '';
  const repo = repoFromCommand(command, cwd);
  const surface = op === 'comment' ? 'pr-comment' : title || body ? 'pr-body' : 'pr-title';
  return { surface, repo, title, body };
}

function textOf(action: ProposedAction): { surface: string; repo: string | null; title: string; body: string } | null {
  switch (action.kind) {
    case 'pr':
      return {
        surface: action.op === 'comment' ? 'pr-comment' : 'pr-body',
        repo: normalizeRepo(action.repo),
        title: action.title ?? '',
        body: action.body ?? '',
      };
    case 'bash':
      return parseGhCommand(action.command, action.cwd);
    default:
      return null;
  }
}

export const readabilityRule = {
  name: RULE_NAME,

  evaluate(action: ProposedAction): RuleVerdict {
    const found = textOf(action);
    if (!found) return allow();
    // Unconfigured means `readabilityVerdict` itself is SILENT for everything, never a
    // refusal -- skip straight through rather than reading a contract that is not there.
    const state = getReadabilityContractState();
    if (!state.ok) return allow();
    if (found.repo !== null && !state.contract.outward_repos.includes(found.repo)) return allow();
    const asOf = new Date().toISOString().slice(0, 10);

    // The ticket-key check only fires on surface 'pr-title', but `found.surface` reads
    // 'pr-body' whenever there is a body to check sections/ceilings on -- both checks
    // matter for a `gh pr create`, so both run rather than one silently shadowing the
    // other.
    if (found.title) {
      const titleVerdict = readabilityVerdict('pr-title', found.repo, found.title, '', undefined, asOf);
      if (titleVerdict.verdict === 'DENY') return deny(RULE_NAME, titleVerdict.reason);
    }
    const verdict = readabilityVerdict(found.surface, found.repo, found.title, found.body, undefined, asOf);
    if (verdict.verdict !== 'DENY') return allow();
    return deny(RULE_NAME, verdict.reason);
  },
};
