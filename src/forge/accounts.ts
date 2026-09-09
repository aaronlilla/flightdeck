/**
 * The account registry: which Claude accounts a run can launch under, and which config
 * directory each one authenticates through.
 *
 * `~/.forge/accounts/registry.json` (or the equivalent under `FORGE_HOME`), a plain
 * array written whole on every change -- the same shape `queue-wire.ts` and
 * `integrations.ts` already use for their own small JSON stores. Nothing here spawns a
 * process or reads a credential file: this module only ever writes what a completed
 * connect attempt (`accounts-connect.ts`) already proved works, and reads it back for
 * `accountFor` (`governor.ts`) and the console routes to use.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { AccountUsage } from './accounts-usage.js';
import { isLimited, usedFraction } from './accounts-usage.js';
import type { ForgeEvent } from './journal.js';
import { fleetConfigDir, forgeHome } from './paths.js';

export type AccountProvider = 'claude' | 'codex';

export interface AccountRecord {
  id: string;
  /** Which login this is: a Claude config directory or a Codex home. Rows written
   *  before providers existed read as `claude`. */
  provider: AccountProvider;
  /** The email the subscription is under; the account's name everywhere it is shown.
   *  Absent only for a row whose login has not been probed yet. */
  email?: string;
  /** Kept for rows written before email became the name. New rows set it to the email. */
  label: string;
  /** `CLAUDE_CONFIG_DIR` for a Claude login; `CODEX_HOME` for a Codex one. */
  configDir: string;
  connectedAt: number;
}

export function accountsRegistryPath(): string {
  return join(forgeHome(), 'accounts', 'registry.json');
}

interface StoredFile {
  accounts: AccountRecord[];
}

function readStored(path: string): StoredFile {
  if (!existsSync(path)) return { accounts: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredFile>;
    return { accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [] };
  } catch {
    // A torn write (a crash mid-save) reads as empty rather than throwing -- the same
    // tolerance every other small JSON store in this codebase gives a half-written file.
    return { accounts: [] };
  }
}

function writeStored(path: string, value: StoredFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

/** Every connected account, in the order they were added. */
export function loadAccounts(path: string = accountsRegistryPath()): AccountRecord[] {
  return readStored(path).accounts.map((account) => ({ ...account, provider: account.provider ?? 'claude' }));
}

/** What a row is called: its email, or the legacy label until a probe names it. */
export function accountName(account: Pick<AccountRecord, 'email' | 'label'>): string {
  return account.email ?? account.label;
}

/** Appends one account. The caller (a completed connect attempt) is what already
 *  proved the account works; this only persists it. */
export function addAccount(record: AccountRecord, path: string = accountsRegistryPath()): void {
  const stored = readStored(path);
  stored.accounts.push(record);
  writeStored(path, stored);
}

/** Drops one account by id. A no-op, not a throw, when the id is not there -- the same
 *  tolerance `Registry.remove` gives a goal that already left. */
export function removeAccount(id: string, path: string = accountsRegistryPath()): void {
  const stored = readStored(path);
  stored.accounts = stored.accounts.filter((account) => account.id !== id);
  writeStored(path, stored);
}

/**
 * How many currently-live runs are attributed to each account, re-derived from the
 * journal's own `run.started` rows and the caller's own list of goals still live right
 * now (a registry read with a liveness check, the same shape `Registry.all()` plus
 * `processAlive` already gives every other caller). Never cached: a disconnect that
 * asks this twice in the same request gets two fresh answers, which is what lets it
 * catch a run that started or ended between the two checks.
 */
export function liveRunsByAccount(events: ForgeEvent[], liveGoals: string[]): Record<string, number> {
  const accountByRun = new Map<string, string>();
  for (const row of events) {
    if (row.event === 'run.started' && row.run && typeof row['account'] === 'string') {
      accountByRun.set(row.run, row['account'] as string);
    }
  }
  const counts: Record<string, number> = {};
  for (const goal of liveGoals) {
    const account = accountByRun.get(goal);
    if (!account) continue;
    counts[account] = (counts[account] ?? 0) + 1;
  }
  return counts;
}

/**
 * The account a new session of `provider` should launch under: the one with the most
 * headroom that is not inside a rate limit right now, ties broken by fewer live runs,
 * then by the order they were connected. Headroom is the worst of the account's
 * windows as the provider last reported them (`accounts-probe.ts`); an account with no
 * reading yet counts as fully free, so a fresh login is tried before an exhausted one.
 * `undefined` when no account of that provider is usable -- the caller then falls back
 * to the machine's own login, which is what every session used before accounts existed.
 */
export function pickAccount(
  accounts: AccountRecord[], usage: AccountUsage, live: Record<string, number>, now: number,
  provider: AccountProvider = 'claude',
): AccountRecord | undefined {
  const usable = accounts.filter((account) => account.provider === provider && !isLimited(account.id, now, usage));
  if (usable.length === 0) return undefined;
  const worst = (account: AccountRecord): number => usedFraction(account.id, now, usage);
  return usable.reduce((best, account) => {
    const byHeadroom = worst(account) - worst(best);
    if (byHeadroom !== 0) return byHeadroom < 0 ? account : best;
    return (live[account.id] ?? 0) < (live[best.id] ?? 0) ? account : best;
  }, usable[0]!);
}

/**
 * The directory a session should authenticate through: the picked account's, or the
 * machine's own login when no account of that provider is registered or all of them are
 * limited. For Claude that is `CLAUDE_CONFIG_DIR`; for Codex it is `CODEX_HOME`, and
 * the fallback is the user's own `~/.codex` (null here, meaning leave the env alone).
 */
export function configDirForSession(
  accounts: AccountRecord[], usage: AccountUsage, live: Record<string, number>, now: number,
  existsConfigDir?: (path: string) => boolean, provider: AccountProvider = 'claude',
): { configDir: string | null; accountId: string | null } {
  const picked = pickAccount(accounts, usage, live, now, provider);
  if (picked) return { configDir: picked.configDir, accountId: picked.id };
  return { configDir: provider === 'claude' ? fleetConfigDir(existsConfigDir) : null, accountId: null };
}
