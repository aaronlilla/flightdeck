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
      const selected = row.id === FLEET_ACCOUNT_ID ? chosen.claude === null : chosen[row.provider] === row.id;
      items.push({
        id: row.id,
        provider: row.provider,
        ...(email ? { email } : row.record && !row.record.email ? { email: accountName(row.record) } : {}),
        ...(record?.plan ?? reading?.plan ? { plan: record?.plan ?? reading?.plan } : {}),
        connectedAt: row.record?.connectedAt ?? 0,
        liveRuns: live[row.id] ?? 0,
        windows: reading?.windows ?? [],
        ...(reading ? { readAt: reading.at } : {}),
        ...(record?.readError ? { readError: record.readError.error } : {}),
        ...(limit ? { limitedUntil: limit.until, limitedWindow: limit.window } : {}),
        selected,
        ...(row.id === FLEET_ACCOUNT_ID ? { fleet: true } : {}),
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
