/**
 * Where the SDK writes a run's own transcript: `<configDir>/projects/<cwd-key>/
 * <sessionId>.jsonl`. `cwdKey` is the CLI's own encoding, verified 2026-09-10 against a
 * real `projects/` directory (a drive-rooted worktree path maps one-to-one onto its own
 * dash-joined directory name): every `:`, `/` and `\` becomes `-`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function cwdKey(cwd: string): string {
  return cwd.replace(/[:\\/]/g, '-');
}

export function transcriptPathFor(configDir: string, cwd: string, sessionId: string): string {
  return join(configDir, 'projects', cwdKey(cwd), `${sessionId}.jsonl`);
}

/** The first of `configDirs` that holds this session's transcript. A run launches on
 *  whichever login the account picker chose, and the SDK writes under that login's own
 *  folder, so the fleet login's folder alone misses every account-launched run. Session
 *  ids are unique, so the first file found is the run's own. `undefined` when none has
 *  it yet. */
export function findTranscriptPath(configDirs: readonly string[], cwd: string, sessionId: string): string | undefined {
  for (const dir of configDirs) {
    const path = transcriptPathFor(dir, cwd, sessionId);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/** The last `maxLines` lines of a run's transcript file, oldest first, for the drift
 *  judge's prompt. `''` for a file that does not exist yet (a run just started) or that
 *  cannot be read -- never thrown, since one unreadable transcript must not stop the
 *  drift cadence for every other run this tick. */
export function readTranscriptTail(path: string, maxLines: number): string {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return '';
  }
  const lines = contents.split('\n').filter((line) => line.trim().length > 0);
  // Token budget (2026-09-23): a transcript line can carry a whole tool result (file
  // contents, test output), so 40 raw lines averaged ~107k input tokens per drift-judge
  // call. Each line is clipped and the tail is capped from the newest end, which keeps
  // what the judge needs (what the agent just did) at a few thousand tokens.
  const clipped = lines.slice(-maxLines).map((line) =>
    line.length > TRANSCRIPT_LINE_MAX_CHARS ? `${line.slice(0, TRANSCRIPT_LINE_MAX_CHARS)} [clipped]` : line);
  const out: string[] = [];
  let total = 0;
  for (let i = clipped.length - 1; i >= 0; i--) {
    total += clipped[i]!.length + 1;
    if (total > TRANSCRIPT_TAIL_MAX_CHARS && out.length > 0) break;
    out.unshift(clipped[i]!);
  }
  return out.join('\n');
}

/** Per-line and whole-tail character caps for {@link readTranscriptTail}. */
export const TRANSCRIPT_LINE_MAX_CHARS = 1500;
export const TRANSCRIPT_TAIL_MAX_CHARS = 24000;
