/**
 * What happens to a terminal whose login runs dry.
 *
 * A worker that hits a rate limit is parked and relaunched by the governor. A terminal is
 * not: Aaron is sitting in it, and when the login behind it runs out the session simply
 * stops. He decided on 2026-09-10 that it should come back on another login instead, with
 * the conversation intact, and that it must never be a mid-session `/login` -- that
 * rotates credentials and kills every other session on the directory.
 *
 * So the console leaves a note and the terminal reads it. When a login is recorded as
 * limited, every live interactive session on that login's directory gets a marker file
 * under `~/.forge/switch/`, naming where to come back. The shim that launched the terminal
 * looks for that marker once, after its child has exited, and relaunches under the named
 * directory with `--resume`. Nothing polls and nothing is timed: the marker is written on
 * an event that already happens, and read on an exit that already happens.
 *
 * A shared transcript tree is what makes the resume work at all -- proved on CLI 2.1.267
 * before this was written, by starting a session under one config directory and resuming
 * it under another whose `projects/` was a junction to the first's.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { accountName, normalizeDir, pickAccount, type AccountRecord } from './accounts.js';
import { isLimited, type AccountUsage } from './accounts-usage.js';
import { switchDir } from './paths.js';

/** How long a marker is worth acting on. A terminal Aaron left open overnight and closed
 *  in the morning must not silently relaunch itself on a limit that lifted hours ago. */
export const MARKER_FRESH_MS = 10 * 60 * 1000;

export interface SwitchMarker {
  sessionId: string;
  /** The directory the session was running under, so a shim can tell its own marker from
   *  one meant for a terminal on another login. */
  fromConfigDir: string;
  /** Where to come back. `null` when nothing else has room -- the marker still exists, so
   *  the terminal can say so rather than dying silently. */
  toConfigDir: string | null;
  toLabel: string | null;
  reason: string;
  at: number;
}

export interface SwitchDeps {
  accounts: AccountRecord[];
  usage: AccountUsage;
  live: Record<string, number>;
  now: number;
  /** The session ids currently live on a config directory. Backed by the fleet session
   *  feed where that exists, and by the directory's own `sessions/*.json` otherwise. */
  sessionsFor: (configDir: string) => string[];
  /** Queues one line into a live session. Absent when no message route exists yet, which
   *  is not a failure: the marker alone still brings the session back. */
  queueMessage?: (sessionId: string, text: string) => void;
  dir?: string;
}

export function markerPath(sessionId: string, dir: string = switchDir()): string {
  return join(dir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

/** The line the session is told, in the words Aaron reads. */
export function switchMessage(toLabel: string | null): string {
  return toLabel === null
    ? 'Your login hit its limit and no other login has room right now; this session will stop when the window resets.'
    : `Your login hit its limit; exit this session and it comes back on the ${toLabel} login with your conversation intact.`;
}

/**
 * Marks every live terminal on `accountId` to come back somewhere else.
 *
 * Returns the markers written, empty when the account is not actually limited -- the
 * caller may hand this any account at all, and "it is fine" must be the cheap answer.
 * The target is chosen by the same rule a fresh terminal would use, minus the account
 * that just ran out.
 */
export function switchLimitedAccount(accountId: string, deps: SwitchDeps): SwitchMarker[] {
  const account = deps.accounts.find((row) => row.id === accountId);
  if (!account) return [];
  if (!isLimited(accountId, deps.now, deps.usage)) return [];

  const others = deps.accounts.filter((row) => row.id !== accountId);
  const target = pickAccount(others, deps.usage, deps.live, deps.now, account.provider, undefined, 'interactive');
  const toConfigDir = target ? target.configDir : null;
  const toLabel = target ? accountName(target) : null;
  const message = switchMessage(toLabel);

  const dir = deps.dir ?? switchDir();
  mkdirSync(dir, { recursive: true });
  const written: SwitchMarker[] = [];
  for (const sessionId of deps.sessionsFor(account.configDir)) {
    const marker: SwitchMarker = {
      sessionId,
      fromConfigDir: account.configDir,
      toConfigDir,
      toLabel,
      reason: `${accountName(account)} hit its limit`,
      at: deps.now,
    };
    writeFileSync(markerPath(sessionId, dir), JSON.stringify(marker, null, 2), 'utf8');
    deps.queueMessage?.(sessionId, message);
    written.push(marker);
  }
  return written;
}

/** The live session ids a config directory itself knows about: one `<pid>.json` per live
 *  process, which the CLI writes and removes on its own. Used when no session feed exists.
 *  Never throws -- a missing or unreadable directory is "no sessions", not an error. */
export function sessionsFromConfigDir(configDir: string): string[] {
  const dir = join(configDir, 'sessions');
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { sessionId?: string; session_id?: string };
      const id = parsed.sessionId ?? parsed.session_id;
      if (typeof id === 'string' && id) out.push(id);
    } catch {
      // A half-written session file is not a session anyone can resume.
    }
  }
  return out;
}

/**
 * The freshest marker left for a terminal that was running under `fromConfigDir`, or null.
 *
 * Matched on the directory the terminal launched under rather than on a session id read
 * out from under the running child: learning the id mid-run means watching a file the CLI
 * has not written yet, and this design has no timers in it. Age is checked here, not by
 * the caller, because "every exit relaunches" is exactly what an unchecked marker does.
 */
export function readSwitchMarkers(
  fromConfigDir: string, now: number, dir: string = switchDir(), freshMs: number = MARKER_FRESH_MS,
): SwitchMarker[] {
  if (!existsSync(dir)) return [];
  const out: SwitchMarker[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      const marker = JSON.parse(readFileSync(path, 'utf8')) as SwitchMarker;
      if (now - marker.at >= freshMs) {
        // Pruned here rather than left to accumulate: nothing else ever deletes a marker
        // that was never acted on, and every terminal exit re-parses the whole directory.
        rmSync(path, { force: true });
        continue;
      }
      if (normalizeDir(marker.fromConfigDir) !== normalizeDir(fromConfigDir)) continue;
      out.push(marker);
    } catch {
      // Unreadable marker: nothing to act on.
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * The one marker a terminal on `fromConfigDir` may act on, or null.
 *
 * **Null when there is more than one.** Markers are written per session but matched on
 * the directory, which every terminal on that login shares, so picking the freshest means
 * two terminals racing to resume the same conversation while the other is deleted
 * unresumed. One candidate is unambiguous; two is a question for the operator, and the
 * shim prints the ids rather than guessing.
 */
export function readSwitchMarker(
  fromConfigDir: string, now: number, dir: string = switchDir(), freshMs: number = MARKER_FRESH_MS,
): SwitchMarker | null {
  const markers = readSwitchMarkers(fromConfigDir, now, dir, freshMs);
  return markers.length === 1 ? markers[0]! : null;
}

/** Removes a marker once it has been acted on, so an exit never replays it. */
export function clearSwitchMarker(sessionId: string, dir: string = switchDir()): void {
  rmSync(markerPath(sessionId, dir), { force: true });
}
