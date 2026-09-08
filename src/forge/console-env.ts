/**
 * The console launches `forge` through ~/.forge/console.launch.cmd, which sets its
 * FORGE_* configuration from ~/.forge/console.env.cmd before it ever calls the binary.
 * A `forge` verb typed straight into a terminal skips that file, so it sees none of
 * those variables: `forge council` refusing on a missing FORGE_COUNCIL_REPOS the
 * console had all along is that gap, not a real config difference.
 *
 * This fills the gap the same way the shell that launches the console would: read the
 * file, and set only what the calling environment does not already have. A value a
 * terminal exported by hand always wins over the file.
 */
import { readFileSync } from 'node:fs';

const SET_LINE = /^set\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Parses `set NAME=VALUE` lines out of a cmd env file and fills every name from `env`
 * that is not already set there. Returns the names it filled, in file order. A value
 * may itself contain `=`; only the first `=` on the line splits name from value.
 * Trailing `\r` (a CRLF file read on any platform), blank lines, and non-`set` lines
 * are ignored rather than treated as errors, so a stray line in the console's file
 * never breaks a `forge` verb.
 */
export function loadConsoleEnv(path: string, env: NodeJS.ProcessEnv): string[] {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return [];
  }

  const filled: string[] = [];
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const match = SET_LINE.exec(line);
    if (!match) continue;
    const name = match[1];
    const value = match[2];
    if (name === undefined || value === undefined) continue;
    if (env[name] !== undefined) continue;
    env[name] = value;
    filled.push(name);
  }
  return filled;
}
