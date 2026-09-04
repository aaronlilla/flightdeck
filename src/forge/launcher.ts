/**
 * Starting a worker, as code rather than as a shell line somebody remembers.
 *
 * Six goals were launched by hand on 2026-09-04 and four failed on one of the checks
 * below. They share a shape: the session starts, looks healthy, and does the wrong work
 * or no work, which is the most expensive failure here because it spends a tier and
 * leaves nothing to read afterwards. A launcher that refuses is cheaper than a run that
 * has to be noticed.
 *
 * The version pin is the other half. A worker records the Forge revision it started on
 * and keeps it for its whole life. New workers get the new one. Nothing patches a running
 * worker, and nothing patches a live machine's hooks partway through: the half-applied
 * install on 2026-09-04 left a hook that crashed on every plan tool, and the machine had
 * no way to tell which half it was running.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readProcessList } from './fleetwatch.js';
import { fleetConfigDir, forgeHome, runDir } from './paths.js';
import { INHERITED, workerEnv } from './worker.js';

/**
 * The most a /goal condition may carry.
 *
 * Past this the platform truncates it, and a goal running against half a condition
 * reports itself met on the half it can see. That has happened, and it is silent.
 */
export const CONDITION_LIMIT = 4000;

/**
 * A websocket Monitor inside a worker.
 *
 * A queued Monitor event kills a `-p` process mid tool call, and a worker has no console
 * to watch it anyway. Matched on the call rather than on the word, so a brief that
 * describes the events websocket is left alone.
 */
const WS_MONITOR = /Monitor\s*\(\s*\{[^)]*\bws\s*:/i;

export interface LaunchRequest {
  brief: string;
  condition: string;
  /** True when `claude login` is running on the account this worker would use. */
  loginRunning?: boolean;
}

export interface LaunchVerdict {
  ok: boolean;
  refusals: string[];
}

/**
 * Every reason this launch would be a mistake.
 *
 * All of them, not the first: a launcher that reports one problem per attempt turns a
 * two-minute fix into four launches.
 */
export function checkLaunch(request: LaunchRequest): LaunchVerdict {
  const refusals: string[] = [];

  const condition = (request.condition ?? '').trim();
  if (!condition) {
    refusals.push('the condition is empty, so the goal has no way to end');
  } else if (condition.length > CONDITION_LIMIT) {
    refusals.push(
      `the condition is ${condition.length} characters and the limit is ${CONDITION_LIMIT}; `
      + 'past that it is truncated and the goal reports itself met on the half it can see',
    );
  }

  if (request.loginRunning) {
    refusals.push('a claude login is in flight on this account; starting now races the '
      + 'credential this worker is about to use');
  }

  if (WS_MONITOR.test(request.brief ?? '')) {
    refusals.push('the brief opens a websocket Monitor; a queued event kills a -p process '
      + 'mid tool call and a worker has no console to watch');
  }

  return { ok: refusals.length === 0, refusals };
}

/**
 * Whether a `claude login` is running right now.
 *
 * Asked of the process table rather than of a flag file, because the flag is what goes
 * stale. Unreadable means no: refusing every launch because the probe failed is worse
 * than the race it prevents, and the warden checks credentials on its own cadence.
 *
 * Reads through `fleetwatch.ts`'s own process-table reader rather than shelling out a
 * second time: two independent implementations of "is a claude login running" already
 * drifted once (different flags, and only one of them survived Windows dropping `wmic`).
 */
export function loginInFlight(lines: string[] = readProcessList()): boolean {
  return lines.some((line) => /claude(\.exe)?\s+login/i.test(line));
}

/**
 * The environment a worker is launched with.
 *
 * `CLAUDE_CONFIG_DIR` is pinned rather than inherited. Sharing the interactive session's
 * directory means the fleet writes into the store Aaron is using, and a login in either
 * place changes what the other authenticates as.
 */
export function launchEnv(
  parent: NodeJS.ProcessEnv = process.env,
  existsConfigDir?: (path: string) => boolean,
): NodeJS.ProcessEnv {
  const clean = workerEnv(parent);
  clean['CLAUDE_CONFIG_DIR'] = fleetConfigDir(existsConfigDir);
  clean['FORGE_HOME'] = forgeHome();
  clean['FORGE_RUNTIME'] = runtimeVersion();
  return clean;
}

/** The nine names, re-exported so a caller does not have to know which module holds them. */
export { INHERITED };

let cachedVersion: string | undefined;

/**
 * The revision of Forge that is running.
 *
 * The git revision when there is one, the package version otherwise. It only has to be
 * stable within a process and different across a change, because its whole job is to let
 * a run say which code it started under.
 */
export function runtimeVersion(): string {
  if (cachedVersion) return cachedVersion;
  if (process.env['FORGE_RUNTIME']) {
    cachedVersion = process.env['FORGE_RUNTIME'];
    return cachedVersion;
  }
  try {
    cachedVersion = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    cachedVersion = '';
  }
  if (!cachedVersion) cachedVersion = 'unversioned';
  return cachedVersion;
}

export interface RuntimePin {
  version: string;
  at: number;
}

/**
 * The version a run is pinned to, written once and never rewritten.
 *
 * Read before write on purpose: a run that has already started keeps the code it started
 * under even if the runtime has moved on underneath it. Upgrading a worker mid-flight
 * means its first half and its second half disagree about what the system does, and
 * nothing in the journal would say so.
 */
export function pinnedRuntime(run: string): RuntimePin {
  const dir = runDir(run);
  const path = join(dir, 'runtime.json');
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as RuntimePin;
    } catch {
      // A torn pin is worse than no pin: fall through and write a fresh one.
    }
  }
  const pin: RuntimePin = { version: runtimeVersion(), at: Date.now() };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(pin, null, 2), 'utf8');
  return pin;
}
