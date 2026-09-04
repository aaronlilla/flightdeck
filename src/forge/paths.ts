/**
 * Where Forge keeps its state, without any machine's layout written into the source.
 *
 * flightdeck is checked for this: a path with a drive letter or a home directory in it
 * ties the repository to one desktop, and the check that enforces it is right. Everything
 * here is derived from the environment or from the user's home, and every one of them is
 * overridable, which is also what lets a specimen point the whole tree at a temporary
 * directory.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The root of Forge's state: journal, runs, lanes, inbox, packets. */
export function forgeHome(): string {
  return process.env['FORGE_HOME'] ?? join(homedir(), '.forge');
}

export function journalPath(): string {
  return process.env['FORGE_JOURNAL'] ?? join(forgeHome(), 'fleet.jsonl');
}

export function lanesDir(): string {
  return join(forgeHome(), 'lanes');
}

export function inboxDir(): string {
  return join(forgeHome(), 'inbox');
}

export function packetsDir(): string {
  return join(forgeHome(), 'packets');
}

export function runsDir(): string {
  return join(forgeHome(), 'runs');
}

/** The per-run directory: logs, dumps, and the run's own inbox. */
export function runDir(run: string): string {
  return join(runsDir(), run.replace(/[^A-Za-z0-9._-]/g, '_'));
}

export function gotchasDir(): string {
  return join(forgeHome(), 'gotchas');
}

/**
 * The config directory a worker's Claude Code process uses.
 *
 * Pinned to the fleet's own directory rather than inherited. Sharing the interactive
 * login's directory is how a worker ends up writing to the same session store Aaron is
 * using, and how a `claude login` in one place changes what the fleet authenticates as.
 */
export function fleetConfigDir(): string {
  return process.env['FORGE_CONFIG_DIR'] ?? join(forgeHome(), 'claude');
}

/** Create every directory Forge writes to. Called once at startup, safe to repeat. */
export function ensureHome(): string {
  const root = forgeHome();
  for (const dir of [root, lanesDir(), inboxDir(), packetsDir(), runsDir(), gotchasDir()]) {
    mkdirSync(dir, { recursive: true });
  }
  return root;
}
