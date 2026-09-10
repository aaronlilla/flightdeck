/**
 * Where the SDK writes a run's own transcript: `<configDir>/projects/<cwd-key>/
 * <sessionId>.jsonl`. `cwdKey` is the CLI's own encoding, verified 2026-09-10 against a
 * real `projects/` directory (a drive-rooted worktree path maps one-to-one onto its own
 * dash-joined directory name): every `:`, `/` and `\` becomes `-`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function cwdKey(cwd: string): string {
  return cwd.replace(/[:\\/]/g, '-');
}

export function transcriptPathFor(configDir: string, cwd: string, sessionId: string): string {
  return join(configDir, 'projects', cwdKey(cwd), `${sessionId}.jsonl`);
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
  return lines.slice(-maxLines).join('\n');
}
