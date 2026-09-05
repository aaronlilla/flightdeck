/**
 * Ported from ~/.claude/hooks/gitflow_guard.py, scoped to what Council's gate needs
 * rather than the hook's full surface (worktree-naming enforcement, per-repo advisories):
 * this stream's acceptance specimens are "gitflow rule ported and proven" and "backend
 * gate never merges", both about a state-changing action landing on a protected branch
 * of a repo whose merges require a human's coordination.
 *
 * `2026-09-04-forge-council.md` decision 1: this is a pure function, so it takes
 * `branch` and `controlled` from the caller instead of shelling out to `git` itself or
 * hardcoding one deployment's repo names (this repo stays project agnostic; the concrete
 * classification of which repos are controlled is Council's own registry, read by the
 * caller before it builds the action).
 */
import { deny, allow } from './types.ts';
import type { ProposedAction, RuleVerdict } from './types.ts';

const PROTECTED = new Set(['develop', 'main', 'master']);

const READONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'fetch', 'remote', 'rev-parse', 'ls-files',
  'ls-remote', 'describe', 'blame', 'shortlog', 'reflog', 'config', 'var',
  'check-ignore', 'whatchanged', 'grep', 'cat-file', 'symbolic-ref', 'help',
  'version', 'count-objects',
]);

const RULE_NAME = 'gitflow';

function tokenize(command: string): string[] {
  return command.split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function pushTarget(args: string[], branch: string | undefined): string | undefined {
  const positional = args.filter((a) => !a.startsWith('-'));
  if (positional.length < 2) return branch;
  const refspec = positional[1] ?? '';
  let dst = refspec.includes(':') ? refspec.split(':').pop() ?? '' : refspec;
  dst = dst.replace('refs/heads/', '').replace(/^\+/, '').trim();
  if (!dst || dst === 'HEAD') return branch;
  return dst;
}

function blocked(what: string, target: string): RuleVerdict {
  return deny(
    RULE_NAME,
    `${what} would put changes on \`${target}\` in a controlled-code repo. That merge ` +
      'requires coordinating with the repo owner first; branch from develop as ' +
      'feature/<name> instead.',
  );
}

export const gitflowRule = {
  name: RULE_NAME,

  evaluate(action: ProposedAction): RuleVerdict {
    if (action.kind === 'bash') {
      if (!action.controlled) return allow();
      const tokens = tokenize(action.command);
      if (tokens[0] !== 'git' && tokens[0] !== 'gh') return allow();

      if (tokens[0] === 'git') {
        const sub = tokens[1];
        const args = tokens.slice(2);
        if (!sub || READONLY_GIT.has(sub)) return allow();
        if (sub === 'push') {
          const target = pushTarget(args, action.branch);
          if (target && PROTECTED.has(target)) return blocked('`git push`', target);
          return allow();
        }
        if (['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am'].includes(sub)) {
          if (action.branch && PROTECTED.has(action.branch)) {
            return blocked(`\`git ${sub}\` on ${action.branch}`, action.branch);
          }
          return allow();
        }
        if (sub === 'reset' && args.includes('--hard')) {
          if (action.branch && PROTECTED.has(action.branch)) {
            return blocked('`git reset --hard`', action.branch);
          }
          return allow();
        }
        return allow();
      }

      // gh
      const verb = `${tokens[1] ?? ''} ${tokens[2] ?? ''}`.trim();
      if (verb === 'pr merge') {
        if (action.branch && PROTECTED.has(action.branch)) {
          return blocked('`gh pr merge`', action.branch);
        }
      }
      return allow();
    }

    if (action.kind === 'commit') {
      if (!action.controlled) return allow();
      if (action.branch && PROTECTED.has(action.branch)) {
        return blocked('a commit', action.branch);
      }
      return allow();
    }

    if (action.kind === 'pr') {
      if (!action.controlled) return allow();
      if (action.op === 'merge') {
        const base = action.base ?? 'develop';
        return blocked('`gh pr merge`', base);
      }
      // `create`, `comment`, `edit` are allowed: the backend gate opens a draft PR and
      // pings the owner, it never merges. See specimen "backend gate never merges".
      return allow();
    }

    return allow();
  },
};
