/**
 * The per-account window probe.
 *
 * For each Claude account it opens one SDK query under that account's config dir with a
 * streaming input that never yields, asks the SDK for the structured `/usage` data, then
 * interrupts and closes. Confirmed on 2026-09-08 against the live fleet dir: the usage
 * call answers in about three seconds before any turn, the session's `model_usage`
 * stays empty, and no message is ever pulled from the input. The probe costs nothing on
 * the plan.
 *
 * Every probe journals `account.probe` (did the call answer, or what it threw) and, on
 * an answer, one `account.window` row per plan window. `rate_limits_available: false`
 * (an API key or a third-party provider session) journals both windows as
 * `unavailable` with no utilization, so the board keeps its last reading and says the
 * probe could not see this account's windows.
 *
 * The usage method is the SDK's own experimental one, named as such. When it goes, this
 * file is the only caller to change; the live `rate_limit_event` stream through
 * `sdkengine.ts` is the other signal and needs nothing from here.
 */
import { query as sdkQuery, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';

import { PushStream } from '../adapter/stream.js';
import type { QueryFn } from '../adapter/engine.js';
import { claudeAccounts, type Account } from './accounts.js';
import type { Journal } from './journal.js';
import { workerEnv } from './worker.js';

export type WindowStatus = 'allowed' | 'allowed_warning' | 'rejected' | 'unavailable';

export interface WindowReading {
  window: 'five_hour' | 'seven_day';
  status: WindowStatus;
  utilization: number | null;
  /** Milliseconds since the epoch, or null when the response named no reset. */
  resetsAt: number | null;
}

/** The subset of the SDK's usage response the probe reads. Typed here rather than
 *  imported so a change in the experimental shape fails in this file, loudly. */
export interface UsageLike {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: {
    five_hour?: { utilization: number | null; resets_at: string | null } | null;
    seven_day?: { utilization: number | null; resets_at: string | null } | null;
  } | null;
  session?: { model_usage?: Record<string, unknown> };
}

const WINDOWS: Array<WindowReading['window']> = ['five_hour', 'seven_day'];

/**
 * The usage call reports utilization without a status; the live event reports a status
 * without utilization. This reads a status out of the number the same way the product
 * does at the edge: a window at or past 100 is rejected, anything under it allowed. The
 * `allowed_warning` step comes only from the live event, which knows the threshold.
 */
export function windowsFromUsage(usage: UsageLike): WindowReading[] {
  if (!usage.rate_limits_available || !usage.rate_limits) {
    return WINDOWS.map((window) => ({ window, status: 'unavailable', utilization: null, resetsAt: null }));
  }
  return WINDOWS.map((window) => {
    const row = usage.rate_limits?.[window];
    const utilization = typeof row?.utilization === 'number' ? row.utilization : null;
    const parsed = row?.resets_at ? Date.parse(row.resets_at) : Number.NaN;
    const resetsAt = Number.isNaN(parsed) ? null : parsed;
    if (utilization === null) return { window, status: 'unavailable', utilization: null, resetsAt };
    return { window, status: utilization >= 100 ? 'rejected' : 'allowed', utilization, resetsAt };
  });
}

export interface ProbeDeps {
  accounts: Account[];
  journal: Journal;
  /** A working directory for the probe's query; nothing is read or written there. */
  cwd: string;
  queryFn?: QueryFn;
  /** Cap on the usage call. A probe that hangs is a defect to report, never a wait. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ProbeResult {
  account: string;
  ok: boolean;
  error?: string;
  readings: WindowReading[];
  subscription: string | null;
}

function timeout<T>(ms: number, label: string): Promise<T> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not answer within ${ms} ms`)), ms);
    timer.unref();
  });
}

async function probeOne(
  account: { id: string; configDir: string }, deps: ProbeDeps,
): Promise<ProbeResult> {
  const queryFn = deps.queryFn ?? (sdkQuery as unknown as QueryFn);
  const timeoutMs = deps.timeoutMs ?? 15_000;
  const env = workerEnv(deps.env ?? process.env);
  env['CLAUDE_CONFIG_DIR'] = account.configDir;
  const input = new PushStream<never>();
  const options: Options = {
    cwd: deps.cwd,
    env,
    // Nothing from disk: a probe under a strange dir must not pick up hooks, MCP servers
    // or a project prompt, and it never takes a turn that could use any of them.
    settingSources: [],
    tools: [],
    maxTurns: 1,
    includePartialMessages: false,
    stderr: () => {},
  };
  let handle: Query | null = null;
  const drain = async (h: Query) => {
    try {
      for await (const _message of h) { /* the probe never sends a turn, so nothing arrives */ }
    } catch {
      // A closed or interrupted generator ends the drain; the usage call already answered
      // or failed on its own, and that is the result that counts.
    }
  };
  let pump: Promise<void> = Promise.resolve();
  try {
    handle = queryFn({ prompt: input as unknown as AsyncIterable<never>, options }) as Query;
    pump = drain(handle);
    const usage = await Promise.race([
      handle.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() as Promise<UsageLike>,
      timeout<UsageLike>(timeoutMs, `usage for account '${account.id}'`),
    ]);
    const readings = windowsFromUsage(usage);
    const subscription = usage.subscription_type ?? null;
    deps.journal.append({
      event: 'account.probe', actor: 'probe', account: account.id, ok: true,
      subscription, rateLimitsAvailable: usage.rate_limits_available === true,
    });
    for (const reading of readings) {
      deps.journal.append({ event: 'account.window', actor: 'probe', account: account.id, ...reading });
    }
    return { account: account.id, ok: true, readings, subscription };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.journal.append({ event: 'account.probe', actor: 'probe', account: account.id, ok: false, error: message });
    return { account: account.id, ok: false, error: message, readings: [], subscription: null };
  } finally {
    input.end();
    if (handle) {
      try { await Promise.race([handle.interrupt(), timeout(2_000, 'interrupt')]); } catch { /* closing anyway */ }
      try { await Promise.race([handle.return(undefined), timeout(2_000, 'return')]); } catch { /* closing anyway */ }
    }
    await Promise.race([pump, timeout(2_000, 'drain')]).catch(() => undefined);
  }
}

/** Probes every Claude account in turn, one query at a time, and never the Codex row. */
export async function probeAccounts(deps: ProbeDeps): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const account of claudeAccounts(deps.accounts)) {
    results.push(await probeOne(account, deps));
  }
  return results;
}
