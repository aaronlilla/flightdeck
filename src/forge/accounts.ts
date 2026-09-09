/**
 * The account registry: which Claude accounts a run can launch under, and which config
 * directory each one authenticates through.
 *
 * `~/.forge/accounts/registry.json` (or the equivalent under `FORGE_HOME`), a plain
 * array written whole on every change -- the same shape `queue-wire.ts` and
 * `integrations.ts` already use for their own small JSON stores. Nothing here spawns a
 * process or reads a credential file: this module only ever writes what a completed
 * connect attempt (`accounts-connect.ts`) already proved works, or what `forge accounts
 * add` was told about a directory the operator already logged in by hand, and reads it
 * back for `accountFor` (`governor.ts`), the accounts probe, and the console routes.
 *
 * Two refusals, on every write: a `configDir` equal to the operator's own `~/.claude`,
 * which a worker must never share, and a duplicate id or a duplicate dir. Credential
 * files under a config dir are never opened here or anywhere in Forge; the only way a
 * dir is checked is the SDK usage call the probe (`accounts-probe.ts`) makes under it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { ForgeEvent } from './journal.js';
import { forgeHome } from './paths.js';

export interface AccountRecord {
  id: string;
  label: string;
  configDir: string;
  connectedAt: number;
  /** Concurrency ceiling for this account's admission. Read, shown, not yet enforced
   *  by the governor. */
  maxConcurrent?: number;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

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

/** One comparable form for a directory: absolute, forward slashes, no trailing slash,
 *  and case folded on Windows where the filesystem is. */
export function normalizeDir(dir: string): string {
  let out = resolve(dir).replace(/\\/g, '/');
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

const ID_SHAPE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * The registry's own refusals, checked against a candidate full list of accounts (the
 * existing set plus whatever is being added). Used both to gate a write here and, via
 * `checkAddCandidate`, to gate a candidate before anything -- a probe included -- is
 * even attempted for it.
 */
export function validateAccounts(accounts: AccountRecord[], ownDir: string = join(homedir(), '.claude')): Verdict {
  const own = normalizeDir(ownDir);
  const ids = new Set<string>();
  const dirs = new Set<string>();
  for (const account of accounts) {
    if (!ID_SHAPE.test(account.id)) return { ok: false, reason: `account id '${account.id}' must be letters, digits, dots, dashes or underscores` };
    if (ids.has(account.id)) return { ok: false, reason: `duplicate account id '${account.id}'` };
    ids.add(account.id);
    if (typeof account.configDir !== 'string' || !account.configDir.trim()) {
      return { ok: false, reason: `account '${account.id}' has no configDir` };
    }
    const dir = normalizeDir(account.configDir);
    if (dir === own) return { ok: false, reason: `account '${account.id}' points at the operator's own config dir; a worker never shares that login` };
    if (dirs.has(dir)) return { ok: false, reason: `account '${account.id}' repeats a config dir another account already uses` };
    dirs.add(dir);
    if (account.maxConcurrent !== undefined && (!Number.isInteger(account.maxConcurrent) || account.maxConcurrent < 1)) {
      return { ok: false, reason: `account '${account.id}' has a maxConcurrent that is not a positive integer` };
    }
  }
  return { ok: true };
}

/** The same refusals a write applies, without performing one. `forge accounts add` and
 *  a browser connect attempt both run this before doing anything else, so a dir the
 *  registry would refuse (the operator's own `~/.claude` above all) is never even
 *  probed or logged into. */
export function checkAddCandidate(
  existing: AccountRecord[],
  candidate: { id: string; configDir: string; maxConcurrent?: number },
): Verdict {
  const account: AccountRecord = { id: candidate.id, label: candidate.id, configDir: candidate.configDir, connectedAt: 0 };
  if (candidate.maxConcurrent !== undefined) account.maxConcurrent = candidate.maxConcurrent;
  return validateAccounts([...existing, account]);
}

/** Every connected account, in the order they were added. */
export function loadAccounts(path: string = accountsRegistryPath()): AccountRecord[] {
  return readStored(path).accounts;
}

/** Appends one account, after the same refusals `validateAccounts` applies to every
 *  write. The caller (a completed connect attempt, or `forge accounts add`) is what
 *  already proved the account works; this both persists it and holds the line on
 *  shape, duplicates and the operator's own dir. Throws rather than silently refusing,
 *  since both callers are already inside a try/catch that turns a thrown reason into a
 *  reported failure. */
export function addAccount(record: AccountRecord, path: string = accountsRegistryPath()): void {
  const stored = readStored(path);
  const verdict = validateAccounts([...stored.accounts, record]);
  if (!verdict.ok) throw new Error(verdict.reason);
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
