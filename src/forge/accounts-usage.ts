/**
 * What each account's rate limits are doing, across processes.
 *
 * `WindowGate` (`governor.ts`) already tracks a rate-limit pause per account and
 * window, but it lives in memory and every launch builds a fresh one, so a limit one
 * worker hit was invisible to the next launch's choice of account. That is the whole
 * reason failover never happened: the selector could not tell an exhausted account from
 * a fresh one. This module is that memory, at
 * `~/.forge/accounts/usage.json` (or under `FORGE_HOME`), written whole on every change
 * like the account registry beside it.
 *
 * Two facts are recorded, and only these two, because only these two have a real
 * source:
 *
 * - `limitedUntil`, from the reset time parsed out of a rate-limit error
 *   (`resolveResetTime`). A call has to actually hit the limit for this to exist.
 * - `plan`, from `claude auth status --json`'s `subscriptionType`.
 *
 * There is deliberately no "percent of the window used" field. The design draws a
 * headroom bar, and the Claude SDK reports per-turn token usage and context-window
 * remaining but nothing about the five-hour or seven-day account window, so a
 * percentage here would be a number with no measurement behind it. The console shows
 * the limit state it can prove instead, and the missing source is a roadmap item.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { WindowReading } from './accounts-probe.js';
import type { RateLimitWindow } from './governor.js';
import { forgeHome } from './paths.js';

/** The last live reading of an account's windows, as the provider reported them. */
export interface AccountReading {
  at: number;
  email?: string;
  plan?: string;
  /** Which subscription this login is on, from the profile call. */
  accountUuid?: string;
  windows: WindowReading[];
}

export interface AccountWindowState {
  /** Epoch ms the limit lifts, from the error that reported it. */
  limitedUntil: number;
  /** When the limit was seen, so a stale record can be read as stale. */
  seenAt: number;
}

export interface AccountUsageRecord {
  /** `subscriptionType` from the last successful auth probe: `max`, `pro`, `team`. */
  plan?: string;
  planAt?: number;
  windows?: Partial<Record<RateLimitWindow, AccountWindowState>>;
  /** The last successful probe. Kept across a failed one, so a row never goes blank
   *  because the network blinked. */
  reading?: AccountReading;
  /** Why the most recent probe failed, and when. Cleared by the next success. */
  readError?: { at: number; error: string };
}

export type AccountUsage = Record<string, AccountUsageRecord>;

export function accountsUsagePath(): string {
  return join(forgeHome(), 'accounts', 'usage.json');
}

export function readAccountUsage(path: string = accountsUsagePath()): AccountUsage {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as AccountUsage : {};
  } catch {
    // A torn write reads as empty, the same tolerance the registry beside it gives.
    return {};
  }
}

function write(path: string, value: AccountUsage): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

/** Records that `account` hit its limit on `window`, and when that lifts. */
export function recordRateLimit(
  account: string, window: RateLimitWindow, limitedUntil: number, now: number,
  path: string = accountsUsagePath(),
): void {
  const usage = readAccountUsage(path);
  const record = usage[account] ?? {};
  usage[account] = { ...record, windows: { ...record.windows, [window]: { limitedUntil, seenAt: now } } };
  write(path, usage);
}

/** Records the plan an auth probe reported for `account`. */
export function recordPlan(
  account: string, plan: string, now: number, path: string = accountsUsagePath(),
): void {
  const usage = readAccountUsage(path);
  usage[account] = { ...(usage[account] ?? {}), plan, planAt: now };
  write(path, usage);
}

/** Stores a live reading. The plan it carries becomes the account's. */
export function recordReading(
  account: string, reading: AccountReading, path: string = accountsUsagePath(),
): void {
  const usage = readAccountUsage(path);
  const prev = usage[account] ?? {};
  delete prev.readError;
  usage[account] = { ...prev, reading, ...(reading.plan ? { plan: reading.plan, planAt: reading.at } : {}) };
  write(path, usage);
}

/** Stores why a probe failed, leaving the previous reading in place. */
export function recordReadError(
  account: string, error: string, now: number, path: string = accountsUsagePath(),
): void {
  const usage = readAccountUsage(path);
  usage[account] = { ...(usage[account] ?? {}), readError: { at: now, error } };
  write(path, usage);
}

/** Whether this account has ever been read successfully. `usedFraction` cannot say so
 *  on its own -- it returns 0 both for "measured, empty" and "never measured" -- and the
 *  difference decides which account a launch picks (`pickAccount`). */
export function hasReading(account: string, usage: AccountUsage): boolean {
  return (usage[account]?.reading?.windows?.length ?? 0) > 0;
}

/**
 * Whether a window can stop a run of `model`. An unscoped window (`session`, `weekly`)
 * always can. A model-scoped one (`weekly:Fable`) only binds on its own model: a Fable
 * weekly bucket at 87% has no say over a Sonnet run, and counting it made an account
 * look exhausted for work it could still do.
 *
 * With no model named the old behaviour stands -- every window counts -- so a caller
 * that does not know what it is about to launch stays conservative.
 */
function windowBinds(key: string, model?: string): boolean {
  const colon = key.indexOf(':');
  if (colon < 0) return true;
  if (!model) return true;
  const scoped = key.slice(colon + 1).toLowerCase();
  const wanted = model.toLowerCase();
  return wanted.includes(scoped) || scoped.includes(wanted);
}

/**
 * The worst-used binding window as a 0..1 fraction, off the last reading; 0 when there
 * is no reading yet. Callers that must tell "measured, empty" from "never measured" ask
 * `hasReading` -- this number cannot carry that difference. A window whose reset time
 * has passed no longer counts: the provider will have opened it again.
 */
export function usedFraction(account: string, now: number, usage: AccountUsage, model?: string): number {
  const windows = usage[account]?.reading?.windows ?? [];
  let worst = 0;
  for (const window of windows) {
    if (window.resetsAt !== null && window.resetsAt <= now) continue;
    if (!windowBinds(window.key, model)) continue;
    worst = Math.max(worst, window.usedPct / 100);
  }
  return worst;
}

/** The soonest moment `account` is usable again, or `null` when no limit is on record
 *  or every recorded limit has already lifted. */
export function limitedUntil(
  account: string, now: number, usage: AccountUsage, model?: string,
): { until: number; window: RateLimitWindow } | null {
  const windows = usage[account]?.windows ?? {};
  let latest: { until: number; window: RateLimitWindow } | null = null;
  for (const [window, state] of Object.entries(windows) as [RateLimitWindow, AccountWindowState][]) {
    if (!state || state.limitedUntil <= now) continue;
    if (!latest || state.limitedUntil > latest.until) latest = { until: state.limitedUntil, window };
  }
  // A window the provider reports as fully used is a limit too, until it resets --
  // but only a window that can stop THIS model. A full `weekly:Fable` bucket does not
  // make the account unusable for a Sonnet run, and treating it that way took the
  // account out of the running for work it could still do.
  for (const read of usage[account]?.reading?.windows ?? []) {
    if (read.usedPct < 100 || read.resetsAt === null || read.resetsAt <= now) continue;
    if (!windowBinds(read.key, model)) continue;
    const window: RateLimitWindow = read.key === 'session' ? 'five_hour' : 'seven_day';
    if (!latest || read.resetsAt > latest.until) latest = { until: read.resetsAt, window };
  }
  return latest;
}

/** Whether `account` is inside a recorded limit right now. */
export function isLimited(account: string, now: number, usage: AccountUsage, model?: string): boolean {
  return limitedUntil(account, now, usage, model) !== null;
}
