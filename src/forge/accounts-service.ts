/**
 * The Settings page's view of the linked accounts: every registered login plus the
 * machine's own Claude login, each with the windows its provider last reported and
 * when they reset.
 *
 * Readings come from `accounts-probe.ts` and are cached on disk in the usage store. A
 * `list()` call returns the cache and, when a row's reading is older than `staleMs`,
 * starts one refresh for it in the background -- never awaited on the request, so the
 * console's poll is not held on a provider's response time, and never more than one in
 * flight per account.
 */
import { accountName, pickAccount, type AccountProvider, type AccountRecord } from './accounts.js';
import { probeAccount, readClaudeToken, type Fetch, type UsageReading } from './accounts-probe.js';
import { limitedUntil, recordReadError, recordReading, type AccountUsage } from './accounts-usage.js';
import type { AccountItem } from '../shared/console-model.js';

export const FLEET_ACCOUNT_ID = 'fleet';

export interface AccountsServiceDeps {
  loadAccounts: () => AccountRecord[];
  readUsage: () => AccountUsage;
  recordReading: (account: string, reading: UsageReading & { at: number }) => void;
  recordReadError: (account: string, error: string, now: number) => void;
  /** Runs currently attributed to each account id. */
  liveRuns: () => Record<string, number>;
  /** The machine's own Claude config directory, or null when it holds no login. */
  fleetConfigDir: () => string | null;
  /** Whether the operator has taken that login out of the rotation. Unset reads as in,
   *  which is what every machine that never touched the switch wants. */
  defaultLoginOff?: () => boolean;
  probe: (provider: AccountProvider, dir: string) => Promise<UsageReading>;
  now?: () => number;
  /** A reading older than this is refreshed on the next `list()`. */
  staleMs?: number;
  /**
   * Told when a refresh finds an account that was usable a moment ago and is now inside
   * a limit. This is the event R-58 hangs off: the console wires it to the switch
   * markers, so a terminal sitting on that login learns where to come back.
   *
   * Optional on purpose -- a service with nothing wired simply does not notify, which is
   * what every test and the CLI want. It fires on the EDGE, not on the state, so a login
   * that stays limited for an hour does not rewrite its markers on every poll.
   */
  onLimited?: (accountId: string) => void;
}

const DEFAULT_STALE_MS = 60_000;

/** A row the service reads: a registry record, or the machine login standing in as one. */
interface Row {
  id: string;
  provider: AccountProvider;
  dir: string;
  record?: AccountRecord;
}

export class AccountsService {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: AccountsServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private rows(): Row[] {
    const out: Row[] = [];
    const fleet = this.deps.fleetConfigDir();
    if (fleet) out.push({ id: FLEET_ACCOUNT_ID, provider: 'claude', dir: fleet });
    for (const record of this.deps.loadAccounts()) out.push({ id: record.id, provider: record.provider, dir: record.configDir, record });
    return out;
  }

  /** Every account with its last reading. Stale rows start a refresh in the background. */
  list(): AccountItem[] {
    const now = this.now();
    const usage = this.deps.readUsage();
    const live = this.deps.liveRuns();
    const records = this.deps.loadAccounts();
    const chosen: Partial<Record<AccountProvider, string | null>> = {
      claude: pickAccount(records, usage, live, now, 'claude')?.id ?? null,
      codex: pickAccount(records, usage, live, now, 'codex')?.id ?? null,
    };
    const stale = this.deps.staleMs ?? DEFAULT_STALE_MS;
    const items: AccountItem[] = [];
    for (const row of this.rows()) {
      const record = usage[row.id];
      const reading = record?.reading;
      if ((!reading || now - reading.at > stale) && !(record?.readError && now - record.readError.at < stale)) {
        void this.refreshOne(row);
      }
      const limit = limitedUntil(row.id, now, usage);
      const email = row.record?.email ?? reading?.email;
      // A login that is switched out of the rotation is never the one a session runs on,
      // whatever the registry says, so it never reads as in use.
      const selected = row.id === FLEET_ACCOUNT_ID
        ? chosen.claude === null && !this.deps.defaultLoginOff?.()
        : chosen[row.provider] === row.id;
      items.push({
        id: row.id,
        provider: row.provider,
        ...(email ? { email } : row.record && !row.record.email ? { email: accountName(row.record) } : {}),
        ...(record?.plan ?? reading?.plan ? { plan: record?.plan ?? reading?.plan } : {}),
        connectedAt: row.record?.connectedAt ?? 0,
        ...(row.record?.lastResort ? { lastResort: true } : {}),
        ...(row.record?.maxConcurrent !== undefined ? { maxConcurrent: row.record.maxConcurrent } : {}),
        liveRuns: live[row.id] ?? 0,
        windows: reading?.windows ?? [],
        ...(reading ? { readAt: reading.at } : {}),
        ...(record?.readError ? { readError: record.readError.error } : {}),
        ...(limit ? { limitedUntil: limit.until, limitedWindow: limit.window } : {}),
        selected,
        ...(row.id === FLEET_ACCOUNT_ID
          ? { fleet: true, ...(this.deps.defaultLoginOff?.() ? { off: true } : {}) }
          : {}),
      });
    }
    return items;
  }

  /**
   * The account a launch should use, on a reading taken now rather than whenever the
   * Settings page last polled. Every row of `provider` whose reading is older than
   * `staleMs` is probed first, all of them in parallel, and only then is the choice
   * made.
   *
   * A probe that fails is not fatal and never opens the gate: `refreshOne` records the
   * error and leaves the last reading in place, so a dead network degrades to the last
   * known numbers. An account that has never been read successfully stays unmeasured,
   * and `pickAccount` sorts it last.
   *
   * `model` names what is about to run, so a model-scoped weekly bucket only counts
   * against a run of that model.
   */
  async pickWithRefresh(
    provider: AccountProvider = 'claude', model?: string,
  ): Promise<AccountRecord | undefined> {
    const stale = this.deps.staleMs ?? DEFAULT_STALE_MS;
    const before = this.deps.readUsage();
    const now = this.now();
    await Promise.all(
      this.rows()
        .filter((row) => row.provider === provider)
        .filter((row) => {
          const reading = before[row.id]?.reading;
          return !reading || now - reading.at > stale;
        })
        .map((row) => this.refreshOne(row)),
    );
    return pickAccount(
      this.deps.loadAccounts(), this.deps.readUsage(), this.deps.liveRuns(), this.now(), provider, model,
    );
  }

  /**
   * Whether this provider has any registered row at all, and the earliest still-future
   * reset across every window those rows last reported.
   *
   * One reader, so the launcher's refusal and the console's banner tell the same story
   * rather than each computing "when does this free up" its own way. The fleet row is
   * deliberately not counted: it is the fallback, never a registered account, and
   * counting it would make an empty registry look populated.
   */
  exhaustion(provider: AccountProvider): { registered: boolean; earliestReset: number | null } {
    const now = this.now();
    const usage = this.deps.readUsage();
    const rows = this.deps.loadAccounts().filter((record) => record.provider === provider);
    let earliest: number | null = null;
    for (const row of rows) {
      for (const window of usage[row.id]?.reading?.windows ?? []) {
        const at = window.resetsAt;
        // A reset already in the past tells a launch nothing about when it can run.
        if (at === null || at <= now) continue;
        if (earliest === null || at < earliest) earliest = at;
      }
    }
    return { registered: rows.length > 0, earliestReset: earliest };
  }

  /** Reads every account now, waiting for all of them. For the CLI and for tests. */
  async refreshAll(): Promise<void> {
    await Promise.all(this.rows().map((row) => this.refreshOne(row)));
  }

  private async refreshOne(row: Row): Promise<void> {
    if (this.inFlight.has(row.id)) return;
    this.inFlight.add(row.id);
    const wasLimited = limitedUntil(row.id, this.now(), this.deps.readUsage()) !== null;
    try {
      const reading = await this.deps.probe(row.provider, row.dir);
      this.deps.recordReading(row.id, { ...reading, at: this.now() });
      const nowLimited = limitedUntil(row.id, this.now(), this.deps.readUsage()) !== null;
      if (!wasLimited && nowLimited) this.deps.onLimited?.(row.id);
    } catch (error) {
      this.deps.recordReadError(row.id, error instanceof Error ? error.message : String(error), this.now());
    } finally {
      this.inFlight.delete(row.id);
    }
  }
}

/** `3h 20m`, `45m`, `2d 4h` -- how long until a window frees up, in the shortest form
 *  that still says it. */
function untilWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export type LaunchAccountDecision =
  | { refused: false; account?: AccountRecord }
  | { refused: true; reason: string };

/**
 * What a launch does with `pickWithRefresh`'s answer.
 *
 * Three outcomes, and the middle one is the whole point. An account was picked: run
 * under it. Nothing was picked and NOTHING IS REGISTERED: fall through to the machine's
 * own login, exactly as every launch did before accounts existed -- that path is what
 * makes a fresh install work and must never be taken away. Nothing was picked but rows
 * ARE registered: refuse. Every one of them is spent, and the login the operator is
 * typing into is not spare capacity to borrow (Aaron, 2026-09-10).
 *
 * Held-back rows are already tried first by `pickAccount`'s ranking, so reaching the
 * third case means even those are limited. There is deliberately no second bypass here.
 */
export function launchAccountDecision(
  picked: AccountRecord | undefined,
  state: { registered: boolean; earliestReset: number | null },
  now: number,
): LaunchAccountDecision {
  if (picked) return { refused: false, account: picked };
  if (!state.registered) return { refused: false };
  const when = state.earliestReset !== null && state.earliestReset > now
    ? `the earliest window frees in ${untilWords(state.earliestReset - now)}`
    : 'no reset time is on record for any of them';
  return {
    refused: true,
    reason: `every linked account for this provider is spent or at its ceiling; ${when}`,
  };
}

/** A `fetch` for the probes with a hard deadline, so a hung provider never holds a slot. */
export function timedFetch(timeoutMs = 20_000): Fetch {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { headers: init.headers, signal: controller.signal });
      return { status: response.status, text: () => response.text() };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The real probe, on the real network. */
export function realProbe(fetchFn: Fetch = timedFetch()): AccountsServiceDeps['probe'] {
  return (provider, dir) => probeAccount(provider, dir, fetchFn);
}

/** The machine's Claude login directory when it actually holds a login. */
export function fleetLoginDir(fleetConfigDir: () => string): () => string | null {
  return () => {
    const dir = fleetConfigDir();
    return readClaudeToken(dir) ? dir : null;
  };
}

/** Writers bound to the on-disk usage store. */
export const diskWriters = {
  recordReading: (account: string, reading: UsageReading & { at: number }) => recordReading(account, reading),
  recordReadError,
};
