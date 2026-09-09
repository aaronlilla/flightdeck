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

import type { ForgeEvent } from './journal.js';
import { forgeHome } from './paths.js';

export interface AccountRecord {
  id: string;
  label: string;
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
  return readStored(path).accounts;
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
