/**
 * Where Forge keeps its state, without any machine's layout written into the source.
 *
 * flightdeck is checked for this: a path with a drive letter or a home directory in it
 * ties the repository to one desktop, and the check that enforces it is right. Everything
 * here is derived from the environment or from the user's home, and every one of them is
 * overridable, which is also what lets a specimen point the whole tree at a temporary
 * directory.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The root of Forge's state: journal, runs, lanes, inbox, packets. */
export function forgeHome(): string {
  return process.env['FORGE_HOME'] ?? join(homedir(), '.forge');
}

export function journalPath(): string {
  return process.env['FORGE_JOURNAL'] ?? join(forgeHome(), 'fleet.jsonl');
}

/** Where `forge stop --all`'s kill switch is recorded: present means new launches refuse. */
export function killSwitchPath(): string {
  return join(forgeHome(), 'kill-switch.json');
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

/** One record per live goal, admitted atomically. See registry.ts. */
export function registryDir(): string {
  return join(forgeHome(), 'registry');
}

/** The 4120 server's own bearer token, read fresh on every request (B.3.9). */
export function serverTokenPath(): string {
  return join(forgeHome(), 'server-token');
}

/** The per-run directory: logs, dumps, and the run's own inbox. */
export function runDir(run: string): string {
  return join(runsDir(), run.replace(/[^A-Za-z0-9._-]/g, '_'));
}

export function gotchasDir(): string {
  return join(forgeHome(), 'gotchas');
}

/** Single-flight login locks, one file per account: `<account>.lock` holding whoever's
 *  browser flow is in flight for it (`credential-horizon.ts`). */
export function loginsDir(): string {
  return join(forgeHome(), 'logins');
}

/**
 * The config directory a worker's Claude Code process uses, and which of the three
 * reasons picked it.
 *
 * `FORGE_CONFIG_DIR` wins outright when set. Otherwise this prefers `~/.claude-fleet`,
 * the account every worker already launches with (`CLAUDE_CONFIG_DIR` on every launch
 * line), falling back to `~/.forge/claude` when it is absent.
 *
 * An earlier version of this function preferred `~/.forge/fleet-claude` over
 * `~/.claude-fleet` on the premise that `~/.claude-fleet` was Aaron's own interactive
 * config directory and so off-limits to a worker. That premise was wrong: `~/.claude-fleet`
 * is the fleet account (Aaron's own directory is `~/.claude`), so preferring the
 * forge-owned candidate instead pointed a built `forge` run at a login that was never
 * provisioned, on a machine where the real fleet login sat one directory over unused.
 *
 * `exists` is a parameter rather than a bare `existsSync` call so a specimen can pin both
 * branches without depending on whether this machine happens to have a fleet login on it.
 */
export function fleetConfigDirChoice(exists: (path: string) => boolean = existsSync): {
  dir: string; source: 'override' | 'fleet' | 'forge';
} {
  const override = process.env['FORGE_CONFIG_DIR'];
  if (override) return { dir: override, source: 'override' };
  const fleetDir = join(homedir(), '.claude-fleet');
  if (exists(fleetDir)) return { dir: fleetDir, source: 'fleet' };
  return { dir: join(forgeHome(), 'claude'), source: 'forge' };
}

/**
 * Pinned to the fleet's own directory rather than inherited. Sharing the interactive
 * login's directory is how a worker ends up writing to the same session store Aaron is
 * using, and how a `claude login` in one place changes what the fleet authenticates as.
 */
export function fleetConfigDir(exists: (path: string) => boolean = existsSync): string {
  return fleetConfigDirChoice(exists).dir;
}

/** Create every directory Forge writes to. Called once at startup, safe to repeat. */
export function ensureHome(): string {
  const root = forgeHome();
  for (const dir of [root, lanesDir(), inboxDir(), packetsDir(), runsDir(), gotchasDir(), registryDir()]) {
    mkdirSync(dir, { recursive: true });
  }
  return root;
}
