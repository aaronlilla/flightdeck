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

import type { RateLimitWindow } from './governor.js';
import { forgeHome } from './paths.js';

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

/** The soonest moment `account` is usable again, or `null` when no limit is on record
 *  or every recorded limit has already lifted. */
export function limitedUntil(
  account: string, now: number, usage: AccountUsage,
): { until: number; window: RateLimitWindow } | null {
  const windows = usage[account]?.windows ?? {};
  let latest: { until: number; window: RateLimitWindow } | null = null;
  for (const [window, state] of Object.entries(windows) as [RateLimitWindow, AccountWindowState][]) {
    if (!state || state.limitedUntil <= now) continue;
    if (!latest || state.limitedUntil > latest.until) latest = { until: state.limitedUntil, window };
  }
  return latest;
}

/** Whether `account` is inside a recorded limit right now. */
export function isLimited(account: string, now: number, usage: AccountUsage): boolean {
  return limitedUntil(account, now, usage) !== null;
}
