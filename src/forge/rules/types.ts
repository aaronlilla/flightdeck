/**
 * Roadmap P4.4 / P6.2. The rules module Council owns: pure functions from a proposed
 * action to a verdict, with no model call, no `gh` write, and no process spawn anywhere
 * in this directory (dispatcher decision 1, `2026-09-04-forge-council.md`).
 *
 * This runs in two places once P4.7's follow-up commit wires the second one in: Council's
 * gate calls it on a commit message, a PR title/body, and a diff; the worker's PreToolUse
 * hook calls it on a Bash command or an edit. Both callers pass the same `ProposedAction`
 * shape, which is why the shape names a shell command, a commit message, a PR title and
 * body, a file edit, and a reply, rather than the SDK's own tool-call vocabulary.
 */

/**
 * `branch` and `controlled` are carried explicitly rather than discovered by this module:
 * a rule here is a pure function with no filesystem or `git` access, and this repo stays
 * project agnostic (`check:agnostic`) rather than hardcoding any one deployment's repo
 * names or drive-rooted paths. The caller (Council's gate, which reads a repo registry,
 * or the PreToolUse hook once P4.7 wires it in) is the one place that already knows the
 * current branch and whether the repo it is in is controlled code.
 */
export type ProposedAction =
  | { kind: 'bash'; command: string; cwd: string; branch?: string; controlled?: boolean }
  | { kind: 'commit'; message: string; cwd: string; branch?: string; controlled?: boolean }
  | { kind: 'pr'; op: 'create' | 'merge' | 'comment' | 'edit'; base?: string; repo: string; title?: string; body?: string; cwd: string; controlled?: boolean }
  | { kind: 'edit'; path: string; text: string }
  | { kind: 'reply'; text: string; priorPushback?: string; hadToolCallSince?: boolean };

export type RuleVerdict =
  | { allow: true }
  | { allow: false; rule: string; reason: string };

export interface Rule {
  name: string;
  evaluate(action: ProposedAction): RuleVerdict;
}

export function allow(): RuleVerdict {
  return { allow: true };
}

export function deny(rule: string, reason: string): RuleVerdict {
  return { allow: false, rule, reason };
}
