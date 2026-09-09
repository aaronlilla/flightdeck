/**
 * The Governor: the role that turns a planned run into a scheduled, priced, bounded one.
 *
 * Everything below is a pure function or a small in-memory class. Nothing here opens a
 * session, calls a model, or makes an EAS API call -- the pieces that eventually have to
 * touch a real system (the poller that reads real build state, the wiring that turns
 * `checkBudget`'s answer into an actual pause) belong to whoever assembles this into the
 * live loop. That is also what keeps every specimen in `governor.test.ts` at zero spend.
 *
 * Provider assignment lives in `policy.ts` (`providerFor`), not here, because it is a
 * property of one class and `policy.ts` already owns every other per-class fact.
 */
import { aliasOf, classFor, effectiveGovernorBudget, modelIdFor, priceFor } from './policy.js';
import type { ForgeEvent, FleetState, Usage } from './journal.js';

// ---------------------------------------------------------------------------------------
// Burn ledger, from every worker's modelUsage
// ---------------------------------------------------------------------------------------

export interface ModelUsageEntry {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
  costUsd: number;
}

export interface BurnLedger {
  /** Dollars, keyed by run id. */
  byRun: Record<string, number>;
  /** Dollars, keyed by model-policy class. */
  byClass: Record<string, number>;
  /** Dollars, keyed by the literal model id the SDK billed under. */
  byModel: Record<string, number>;
}

/**
 * The richer ledger the roadmap asks for: queryable by run and by class, not only by
 * tier alias the way `journal.ts`'s `FleetState.burn` already is.
 *
 * Reads only `result.usage` rows. The SDK's own `modelUsage` map on a `result` message
 * already totals every model call made through the query pipeline for that `query()`
 * call -- main loop, Task subagents, sidechains -- so one row here is the whole run's
 * spend for that segment. Reading `subagent.usage` rows as well would double the count;
 * reading neither would drop it. `run.started` rows are folded first, so a run's class
 * is known by the time its first `result.usage` row is seen even when both land in the
 * same replay pass.
 */
export function buildBurnLedger(events: ForgeEvent[]): BurnLedger {
  const ledger: BurnLedger = { byRun: {}, byClass: {}, byModel: {} };
  const classByRun = new Map<string, string>();

  for (const row of events) {
    if (row.event === 'run.started' && row.run && typeof row['className'] === 'string') {
      classByRun.set(row.run, row['className'] as string);
      continue;
    }
    if (row.event !== 'result.usage' || !row.run) continue;
    const modelUsage = row['modelUsage'] as Record<string, ModelUsageEntry> | undefined;
    if (!modelUsage) continue;
    for (const [modelId, entry] of Object.entries(modelUsage)) {
      const spent = entry.costUsd ?? 0;
      ledger.byRun[row.run] = (ledger.byRun[row.run] ?? 0) + spent;
      ledger.byModel[modelId] = (ledger.byModel[modelId] ?? 0) + spent;
      const className = classByRun.get(row.run);
      if (className) ledger.byClass[className] = (ledger.byClass[className] ?? 0) + spent;
    }
  }
  return ledger;
}

function costOf(usage: Usage, alias: string): number {
  const price = priceFor(alias);
  return (usage.input * price.input
    + usage.cacheRead * price.cacheRead
    + usage.cacheCreation * price.cacheWrite
    + usage.output * price.output) / 1e6;
}

/**
 * The B.3.6 per-message sum for one run: every `usage` and `subagent.usage` row's own
 * cost, priced the same way `journal.ts`'s `costOf` prices them. Kept separate from
 * `FleetState.runs[run].costUsd` (which already carries this number) only so this file
 * never has to reach into `journal.ts`'s private fold to read it back out.
 */
function perMessageSum(events: ForgeEvent[], run: string): number {
  let total = 0;
  for (const row of events) {
    if (row.run !== run || !row.usage) continue;
    total += costOf(row.usage, aliasOf(row.model ?? ''));
  }
  return total;
}

/**
 * Compares the result-message sum (`buildBurnLedger`) against the per-message sum
 * (B.3.6) for every run either side has an opinion about, and returns one
 * `burn.mismatch` event per run where they differ by more than 5 percent. The caller
 * appends whatever this returns; nothing here writes to a journal itself, so a specimen
 * can call it against a plain in-memory `FleetState` with no file on disk.
 */
export function reconcileBurn(state: FleetState, ledger: BurnLedger): Array<Partial<ForgeEvent>> {
  const mismatches: Array<Partial<ForgeEvent>> = [];
  const runs = new Set([...Object.keys(ledger.byRun), ...Object.keys(state.runs)]);
  for (const run of runs) {
    const resultSum = ledger.byRun[run] ?? 0;
    const messageSum = perMessageSum(state.events, run);
    if (resultSum === 0 && messageSum === 0) continue;
    const base = Math.max(resultSum, messageSum);
    const diff = Math.abs(resultSum - messageSum);
    if (base > 0 && diff / base > 0.05) {
      mismatches.push({
        event: 'burn.mismatch', run, actor: 'governor',
        resultUsd: resultSum, perMessageUsd: messageSum,
      });
    }
  }
  return mismatches;
}

// ---------------------------------------------------------------------------------------
// Window pause, with a reset time
// ---------------------------------------------------------------------------------------

/**
 * Text a rate-limit error carries, collected in one place so a new pattern is one line
 * here rather than a scan through every call site that might see one.
 */
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate.?limit/i,
  /usage limit/i,
  /try again later/i,
  /too many requests/i,
  /429/,
];

export function isRateLimitMessage(message: string): boolean {
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

const ISO_DATE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/;

/**
 * When the window resets. The Claude Max window size is never exposed by the API (per
 * the spec's own unknowns list), so a reset timestamp is read out of the error text when
 * one is there, and assumed five hours out from `now` when it is not. `now` is a
 * parameter rather than `Date.now()` so a specimen can move the clock instead of the test
 * having to sleep for real hours.
 */
export function resolveResetTime(message: string, now: number): number {
  const found = ISO_DATE.exec(message);
  if (found) {
    const parsed = Date.parse(found[0]);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return now + FIVE_HOURS_MS;
}

export interface QueueEntry {
  run: string;
  tier: string;
}

/**
 * The two rate-limit horizons a Claude account carries. A five-hour pause and a
 * seven-day (weekly) pause are two different budgets that reset on two different
 * clocks -- hitting one says nothing about the other, so they are tracked as two keys
 * rather than one.
 */
export type RateLimitWindow = 'five_hour' | 'seven_day';

/**
 * Soft ceilings per (account, window): a limit event pauses every queued run of the
 * tier it hit, until the resolved reset time, and never earlier. Cheap classes on a
 * different tier are unaffected -- a pause is per tier, not fleet-wide, because a
 * fleet-wide pause would queue work a rate limit never actually touched.
 *
 * P4.8: keyed by `account::window` rather than by tier alone (its shape before this
 * item), so two different Claude accounts' rate-limit pauses never bleed into each
 * other, and an account's five-hour pause never silently pauses its own seven-day
 * window. `tier` on `QueueEntry` still names which class of work an entry is, for the
 * caller's own bookkeeping; `admit()` itself only ever asks about the account/window
 * pair a caller passes it.
 */
export class WindowGate {
  private pausedUntil = new Map<string, number>();

  private key(account: string, window: RateLimitWindow): string {
    return `${account}::${window}`;
  }

  onRateLimitEvent(
    account: string, window: RateLimitWindow, message: string, now: number,
  ): { resumeAt: number } {
    const resumeAt = resolveResetTime(message, now);
    this.pausedUntil.set(this.key(account, window), resumeAt);
    return { resumeAt };
  }

  isPaused(account: string, window: RateLimitWindow, now: number): boolean {
    const key = this.key(account, window);
    const until = this.pausedUntil.get(key);
    if (until === undefined) return false;
    if (now >= until) {
      this.pausedUntil.delete(key);
      return false;
    }
    return true;
  }

  /** Whether `account` is paused on either window right now -- what a caller choosing
   *  an account to launch under actually needs to know, since a run cannot be split
   *  across windows. */
  isAccountPaused(account: string, now: number): boolean {
    return this.isPaused(account, 'five_hour', now) || this.isPaused(account, 'seven_day', now);
  }

  admit(
    entries: QueueEntry[], now: number, window: RateLimitWindow = 'five_hour',
  ): { admitted: QueueEntry[]; queued: QueueEntry[] } {
    const admitted: QueueEntry[] = [];
    const queued: QueueEntry[] = [];
    for (const entry of entries) {
      (this.isPaused(entry.tier, window, now) ? queued : admitted).push(entry);
    }
    return { admitted, queued };
  }
}

// ---------------------------------------------------------------------------------------
// Account selection
// ---------------------------------------------------------------------------------------

/** One Claude account a run can launch under. */
export interface Account {
  id: string;
  configDir: string;
  /** An operator-level pause (mid-disconnect, deliberately taken out of rotation) --
   *  never auto-inferred from rate-limit state, which `windows` already covers. */
  paused?: boolean;
  /** Fraction of each window's own budget already used, from the last
   *  `claude auth status --json` probe (0 = fresh, 1 = exhausted). A window this
   *  account has never been probed for is treated as 0, not as unusable -- an account
   *  with no data yet is exactly the one that should be tried first. */
  utilization?: Partial<Record<RateLimitWindow, number>>;
}

function maxUtilization(account: Account): number {
  const usage = account.utilization ?? {};
  return Math.max(usage.five_hour ?? 0, usage.seven_day ?? 0);
}

/**
 * Picks the account a run should launch under: the least-utilized account that is
 * neither explicitly paused nor rate-limit-paused on either window right now, ties
 * broken by fewest live runs. Returns `undefined` when every account is unusable, so
 * the caller queues the run rather than launching it onto an account this would only
 * push further past its limit.
 *
 * `className` is accepted (and not yet read) so a future per-class account policy --
 * routing a class to only the accounts it is entitled to -- has a place to hang without
 * changing every call site again; today every account is eligible for every class.
 */
export function accountFor(
  className: string,
  accounts: Account[],
  windows: WindowGate,
  live: Record<string, number>,
  now: number,
): Account | undefined {
  void className;
  const usable = accounts.filter((account) => (
    !account.paused && !windows.isAccountPaused(account.id, now)
  ));
  if (usable.length === 0) return undefined;

  let best: Account | undefined;
  let bestUtilization = Number.POSITIVE_INFINITY;
  let bestLive = Number.POSITIVE_INFINITY;
  for (const account of usable) {
    const utilization = maxUtilization(account);
    const liveRuns = live[account.id] ?? 0;
    const better = !best
      || utilization < bestUtilization
      || (utilization === bestUtilization && liveRuns < bestLive);
    if (better) {
      best = account;
      bestUtilization = utilization;
      bestLive = liveRuns;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------
// Conformance per turn
// ---------------------------------------------------------------------------------------

export interface ConformanceResult {
  conforms: boolean;
  event?: Partial<ForgeEvent>;
}

/**
 * `message.model` against the run's class. A mismatch parks the run in the very turn it
 * is seen, through the Warden actuator path (`warden.parked`, carrying both model ids),
 * which `journal.ts` folds into `RunState.state` the same way it folds `run.parked`, so
 * a reader sees the park immediately rather than after some number of turns.
 *
 * A subagent definition is checked the same way: pass its own declared class rather than
 * the parent run's, and the same function applies.
 */
export function checkConformance(run: string, className: string, servingModel: string): ConformanceResult {
  const spec = classFor(className);
  const expected = modelIdFor(spec.model);
  if (servingModel === expected || aliasOf(servingModel) === aliasOf(expected)) {
    return { conforms: true };
  }
  return {
    conforms: false,
    event: {
      event: 'warden.parked', run, actor: 'governor', verdict: 'model-mismatch',
      reason: 'model-mismatch', expectedModel: expected, actualModel: servingModel,
    },
  };
}

// ---------------------------------------------------------------------------------------
// EAS build coalescing
// ---------------------------------------------------------------------------------------

export interface BuildRequest {
  head: string;
  platform: string;
  fingerprint: string;
  at: number;
}

export interface CoalescedBuild {
  key: string;
  requests: BuildRequest[];
}

const DEFAULT_COALESCE_WINDOW_MS = 60_000;

/**
 * Groups build requests by head, platform and fingerprint, merging two that land within
 * `windowMs` of the group's first request into one build. No EAS call is made here; this
 * is the pure grouping step the Council merge gate calls before it ever asks EAS for
 * anything (`onCouncilMerge` below is that integration point).
 */
export function coalesceBuilds(
  requests: BuildRequest[], windowMs = DEFAULT_COALESCE_WINDOW_MS,
): CoalescedBuild[] {
  const groups = new Map<string, CoalescedBuild>();
  const order: CoalescedBuild[] = [];
  for (const request of requests) {
    const key = `${request.head}|${request.platform}|${request.fingerprint}`;
    const existing = groups.get(key);
    const firstAt = existing?.requests[0]?.at ?? request.at;
    if (existing && request.at - firstAt <= windowMs) {
      existing.requests.push(request);
      continue;
    }
    const fresh: CoalescedBuild = { key, requests: [request] };
    // A key reused after its window closed opens a fresh group under the same key,
    // rather than reopening the expired one and pretending the gap never happened.
    groups.set(key, fresh);
    order.push(fresh);
  }
  return order;
}

/**
 * The one integration point exported for the Council merge gate: two merges to `develop`
 * for the same head, platform and fingerprint inside the coalescing window produce one
 * build request rather than two, because this turns each merge into the same
 * `BuildRequest` shape `coalesceBuilds` groups on.
 */
export function onCouncilMerge(
  head: string, platform: string, fingerprint: string, at: number,
): BuildRequest {
  return { head, platform, fingerprint, at };
}

// ---------------------------------------------------------------------------------------
// Budget caps
// ---------------------------------------------------------------------------------------

export interface BudgetDecision {
  allowed: boolean;
  event?: Partial<ForgeEvent>;
}

/**
 * Whether a run may start, checked against the class's own per-run ceiling and the
 * fleet's daily cap, both read from `policy.ts`'s `effectiveGovernorBudget()` -- the
 * policy file's own numbers, merged with whatever the console has overridden in
 * `~/.forge/console/caps.json`, so a cap raised or lowered from the board actually binds
 * the next launch. Checked before any spend happens: the caller passes what the run
 * would spend, not what it already spent, so a refusal here means the run never started
 * rather than merely being logged after the money left. A refusal parks with the same
 * `run.parked` event kind conformance parking uses, carrying a `reason` that tells the
 * two apart.
 */
export function checkBudget(
  run: string, className: string, wouldSpendUsd: number, spentTodayUsd: number, path?: string, forgeHomeDir?: string,
): BudgetDecision {
  const budget = forgeHomeDir !== undefined
    ? effectiveGovernorBudget(path, forgeHomeDir)
    : effectiveGovernorBudget(path);
  const perRunCap = budget.usdPerRun[className];
  if (perRunCap !== undefined && wouldSpendUsd > perRunCap) {
    return {
      allowed: false,
      event: {
        event: 'governor.parked', run, actor: 'governor', verdict: 'budget-cap', reason: 'per-run-cap',
        cap: perRunCap, wouldSpendUsd,
      },
    };
  }
  if (spentTodayUsd + wouldSpendUsd > budget.dailyUsd) {
    return {
      allowed: false,
      event: {
        event: 'governor.parked', run, actor: 'governor', verdict: 'budget-cap', reason: 'daily-cap',
        cap: budget.dailyUsd, wouldSpendUsd, spentTodayUsd,
      },
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------------------
// Codex's own ledger
// ---------------------------------------------------------------------------------------

export interface CodexLedgerTotals {
  count: number;
  totalDurationMs: number;
}

/**
 * Codex's ledger and cap are separate from the fleet's: no USD, folded by count and
 * duration instead. Takes lines rather than a path so this stays a pure function -- the
 * real file lives at `dev-harness/.goal-runs/codex/ledger.jsonl`, in a repo this stream
 * does not touch, so whoever wires this in reads that file and passes its lines here. A
 * line that will not parse is skipped and does not move the count, the same tolerance
 * `journal.ts`'s own replay gives a torn line.
 */
export function foldCodexLedger(lines: string[]): CodexLedgerTotals {
  let count = 0;
  let totalDurationMs = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { duration_ms?: number; durationMs?: number };
      count += 1;
      totalDurationMs += row.duration_ms ?? row.durationMs ?? 0;
    } catch {
      // A torn or unrecognised line carries no usable duration; it does not move the
      // count either, matching journal.ts's own tolerance for a half-written row.
    }
  }
  return { count, totalDurationMs };
}
