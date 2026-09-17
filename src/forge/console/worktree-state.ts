import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import type { WorktreeState } from './abandoned.js';

/**
 * What a worktree holds right now, for the abandoned sweep's courtesy check.
 *
 * Never throws: every git call is wrapped, and anything unreadable answers null, which
 * the sweep treats as "no evidence" rather than as a reason to keep a lane. That is safe
 * because retiring a lane writes one row and never touches a tree -- see `abandoned.ts`.
 */
export function readWorktreeState(cwd: string): WorktreeState | null {
  if (!cwd || !existsSync(cwd)) return { exists: false, dirty: false, unpushed: false };
  const git = (argv: string[]): string | null => {
    try {
      return execFileSync('git', ['-C', cwd, ...argv], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
  const status = git(['status', '--porcelain']);
  if (status === null) return null;
  // No upstream is unpushed by definition: nothing on a remote holds these commits.
  const ahead = git(['log', '--oneline', '@{upstream}..HEAD']);
  const hasUpstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']) !== null;
  const head = git(['log', '--oneline', '-1']);
  const unpushed = hasUpstream ? (ahead ?? '').trim().length > 0 : (head ?? '').trim().length > 0;
  return { exists: true, dirty: status.trim().length > 0, unpushed };
}
