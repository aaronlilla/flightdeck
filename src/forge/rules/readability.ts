/**
 * Order 19 (READABLE BY JOE), applied to Council's proposed actions and to the worker's
 * own PreToolUse hook. Reuses `readabilityVerdict` (`intake/readability.ts`) rather than
 * re-deriving the contract a second time -- the same shared `fixtures.json` both this
 * rule and `hooks/authorship_guard.py` implement.
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
import { readabilityVerdict, OUTWARD_REPOS } from '../intake/readability.ts';

const RULE_NAME = 'readability';

interface ParsedGh {
  surface: 'pr-title' | 'pr-body' | 'pr-comment';
  repo: string | null;
  title: string;
  body: string;
}

/** A double-quoted or single-quoted shell argument value, unescaped just enough to read
 *  the text a human would see -- this rule only needs the prose, never a faithful shell
 *  parse. */
function argValue(command: string, flag: string): string | null {
  const re = new RegExp(`${flag}\\s+"((?:[^"\\\\]|\\\\.)*)"|${flag}\\s+'((?:[^'\\\\]|\\\\.)*)'`);
  const m = re.exec(command);
  if (!m) return null;
  return (m[1] ?? m[2] ?? '').replace(/\\(["'])/g, '$1');
}

function repoFromCommand(command: string, cwd: string): string | null {
  const flagged = argValue(command, '--repo');
  const repoPart = flagged ? flagged.split('/').pop() ?? flagged : null;
  if (repoPart) return repoPart.toLowerCase();
  const segments = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  return last ? last.replace(/^.*--/, '').toLowerCase() : null;
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
        repo: action.repo,
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
    if (found.repo !== null && !OUTWARD_REPOS.includes(found.repo)) return allow();
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
