/**
 * Where Forge keeps its state, without any machine's layout written into the source.
 *
 * flightdeck is checked for this: a path with a drive letter or a home directory in it
 * ties the repository to one desktop, and the check that enforces it is right. Everything
 * here is derived from the environment or from the user's home, and every one of them is
 * overridable, which is also what lets a specimen point the whole tree at a temporary
 * directory.
 */
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The root of Forge's state: journal, runs, lanes, inbox, packets. */
export function forgeHome(): string {
  return process.env['FORGE_HOME'] ?? join(homedir(), '.forge');
}

/** The workspace a `goal` queue item's worker runs from -- the parent of whatever
 *  checkout `forge up` itself is running from, since a goal brief claims its own
 *  worktree under that same parent via `/workon` rather than this one. `FORGE_WORKSPACE_ROOT`
 *  overrides it for a specimen or a machine laid out differently; no path is hardcoded
 *  here, per this file's own rule. */
export function workspaceRoot(): string {
  return process.env['FORGE_WORKSPACE_ROOT'] ?? dirname(process.cwd());
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

/** forge-council-live: where `forge intake --once`'s planner writes the goal brief it
 *  proposes for one queued packet -- never launched, only written. */
export function intakeBriefsDir(): string {
  return join(forgeHome(), 'intake', 'briefs');
}

/** The console's own state: today, the intake queue's own log and its pause flag. */
export function consoleDir(): string {
  return join(forgeHome(), 'console');
}

/** The intake queue's append-only log -- one row per item transition, folded to the
 *  current item list by `QueueStore`. Distinct from the fleet journal: every transition
 *  also writes a `queue.*` row there, but this file is what the board reads to list the
 *  queue itself, the same split `~/.forge/console/actions.jsonl` keeps from the journal
 *  for every other console write. */
export function queuePath(): string {
  return join(consoleDir(), 'queue.jsonl');
}

/** Whether the queue worker is paused, as `{ paused: true }` or absent. Separate from
 *  the kill switch (`killSwitchPath`): the kill switch stops every launch fleet-wide,
 *  this stops only the queue from starting new work. */
export function queuePausedPath(): string {
  return join(consoleDir(), 'queue-paused.json');
}

/** The queue's own width setting: `{ maxInFlight: N }` or absent. Separate from
 *  `queuePausedPath()`: pausing stops every start, this only caps how many run at once.
 *  Read fresh on every tick and every `GET /queue`, never cached, so `POST /queue/width`
 *  takes effect without a restart. */
export function queueWidthPath(): string {
  return join(consoleDir(), 'queue.json');
}

/** Where a queue item's own planned brief lands, when its source is a pasted brief or a
 *  ticket the queue planned itself rather than `forge intake`'s own poll. Kept apart from
 *  `intakeBriefsDir()` so a queue-planned brief is never mistaken for one `forge intake`
 *  wrote from a poll. */
export function queueBriefsDir(): string {
  return join(forgeHome(), 'queue', 'briefs');
}

/**
 * Where the probe briefs the regression corpus references by basename actually live.
 *
 * No default: unlike `forgeHome`, there is no machine-agnostic fallback for "the goals
 * log directory" that would not itself be a drive-rooted path written into source. An
 * unset `FORGE_PROBE_DIR` means a probe entry in the corpus manifest cannot resolve, and
 * that is reported as a missing entry rather than guessed at.
 */
export function probeDir(): string | undefined {
  return process.env['FORGE_PROBE_DIR'];
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

/** The routine store (`routines/*.md`) shipped in the checkout this process runs from --
 *  tracked files, reviewed like code, never a per-machine directory. `FORGE_ROUTINES_DIR`
 *  overrides it for a specimen. */
export function routinesDir(): string {
  const override = process.env['FORGE_ROUTINES_DIR'];
  if (override) return override;
  return fileURLToPath(new URL('../../routines/', import.meta.url));
}
