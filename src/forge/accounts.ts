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
 * back for `accountFor` (`governor.ts`) and the console routes to use.
 *
 * Two refusals, on every write: a duplicate id or config dir, and a duplicate
 * `accountUuid` -- one subscription is one row, however many directories are logged into
 * it. No directory is privileged: the operator's own `~/.claude` is an ordinary account
 * (Aaron, 2026-09-10), because on this machine it was the only pool with room left and
 * the registry was refusing it by name while holding the fleet subscription twice.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { AccountUsage } from './accounts-usage.js';
import { hasReading, isLimited, readAccountUsage, usedFraction, windowBinds } from './accounts-usage.js';
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
  /** The subscription behind this login, from `/api/oauth/profile`'s `account.uuid`.
   *  What a duplicate is actually measured on: two directories logged into one
   *  subscription add no headroom, and that is the case the directory check missed.
   *  Absent on rows written before this existed, which are never deduped by it. */
  accountUuid?: string;
  connectedAt: number;
  /** Concurrency ceiling: an account at or above this many live runs is not admitted. */
  maxConcurrent?: number;
  /** Held back for when everything else is exhausted. The login the operator types into
   *  is marked this way (Aaron, 2026-09-10): worker traffic on it eats the window he is
   *  working in, so it is worth having and not worth spending first. A flag rather than a
   *  path comparison on purpose -- inferring it from `~/.claude` is the rule that refused
   *  the only account with headroom left. */
  lastResort?: boolean;
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
 * `checkAddCandidate`, to gate a candidate before anything is even attempted for it.
 */
export function validateAccounts(accounts: AccountRecord[]): Verdict {
  const ids = new Set<string>();
  const dirs = new Set<string>();
  const uuids = new Map<string, string>();
  for (const account of accounts) {
    if (!ID_SHAPE.test(account.id)) return { ok: false, reason: `account id '${account.id}' must be letters, digits, dots, dashes or underscores` };
    if (ids.has(account.id)) return { ok: false, reason: `duplicate account id '${account.id}'` };
    ids.add(account.id);
    if (typeof account.configDir !== 'string' || !account.configDir.trim()) {
      return { ok: false, reason: `account '${account.id}' has no configDir` };
    }
    const dir = normalizeDir(account.configDir);
    if (dirs.has(dir)) return { ok: false, reason: `account '${account.id}' repeats a config dir another account already uses` };
    dirs.add(dir);
    if (account.accountUuid) {
      const owner = uuids.get(account.accountUuid);
      if (owner) {
        return { ok: false, reason: `account '${account.id}' is the same subscription as '${owner}' behind another directory; one login is one account` };
      }
      uuids.set(account.accountUuid, account.id);
    }
    if (account.maxConcurrent !== undefined && (!Number.isInteger(account.maxConcurrent) || account.maxConcurrent < 1)) {
      return { ok: false, reason: `account '${account.id}' has a maxConcurrent that is not a positive integer` };
    }
  }
  return { ok: true };
}

/** The same refusals a write applies, without performing one. `forge accounts add` and
 *  a browser connect attempt both run this before doing anything else, so a dir the
 *  registry would refuse -- a directory already registered, or a subscription already
 *  registered behind a different directory -- is never probed or logged into twice.
 *  A candidate with no `accountUuid` yet skips only the subscription check; a connect
 *  attempt fills it in from the profile call it already makes. */
export function checkAddCandidate(
  existing: AccountRecord[],
  candidate: { id: string; configDir: string; maxConcurrent?: number; provider?: AccountProvider; accountUuid?: string; lastResort?: boolean },
): Verdict {
  const account: AccountRecord = {
    id: candidate.id, provider: candidate.provider ?? 'claude', label: candidate.id, configDir: candidate.configDir, connectedAt: 0,
  };
  if (candidate.maxConcurrent !== undefined) account.maxConcurrent = candidate.maxConcurrent;
  if (candidate.accountUuid !== undefined) account.accountUuid = candidate.accountUuid;
  if (candidate.lastResort !== undefined) account.lastResort = candidate.lastResort;
  return validateAccounts([...existing, account]);
}

/** Every connected account, in the order they were added. */
export function loadAccounts(path: string = accountsRegistryPath()): AccountRecord[] {
  return readStored(path).accounts.map((account) => ({ ...account, provider: account.provider ?? 'claude' }));
}

/** What a row is called: its email, or the legacy label until a probe names it. */
export function accountName(account: Pick<AccountRecord, 'email' | 'label'>): string {
  return account.email ?? account.label;
}

/** Appends one account, after the same refusals `validateAccounts` applies to every
 *  write. The caller (a completed connect attempt, or `forge accounts add`) is what
 *  already proved the account works; this both persists it and holds the line on
 *  shape and duplicates. Throws rather than silently refusing,
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

/**
 * Who is about to type: a worker Forge launches, or Aaron at a terminal.
 *
 * The two want opposite things from the same registry. A worker must stay off the login
 * he is sitting in, which is what `lastResort` is for. A terminal he opens should PREFER
 * that login -- it is his, its conversation history is there, and spending it is the
 * point -- right up until it is nearly gone, at which point the terminal wants the same
 * answer a worker would give.
 */
export type PickMode = 'worker' | 'interactive';

/** How full the operator's own login may get before an interactive launch stops
 *  preferring it. Under this, a terminal opens on his login; at or above it, a terminal
 *  is routed like a worker and he is told why in one sentence. */
export const INTERACTIVE_OPERATOR_CEILING = 0.9;

/**
 * The first rank key: normally "held-back accounts lose", but inverted for the login the
 * operator types into while that login still has room.
 *
 * Fail-closed on purpose (standing order 1): a held-back row nobody has measured does
 * NOT get preferred. "No reading" is not "has room", and preferring an unmeasured login
 * for every terminal on the machine is exactly the fail-open the pick rule already
 * learned to refuse once.
 */
function heldBackRank(
  account: AccountRecord, usage: AccountUsage, now: number, model: string | undefined, mode: PickMode,
): number {
  if (!account.lastResort) return 0;
  if (mode !== 'interactive') return 1;
  if (!hasReading(account.id, usage)) return 1;
  return usedFraction(account.id, now, usage, model) < INTERACTIVE_OPERATOR_CEILING ? -1 : 1;
}

/**
 * The account a new session of `provider` should launch under: the one with the most
 * headroom that is not inside a rate limit right now, ties broken by fewer live runs,
 * then by the order they were connected. Headroom is the worst of the windows that can
 * actually stop a run of `model` -- a model-scoped weekly bucket for some other model
 * cannot, so it does not count (`usedFraction`).
 *
 * An account nobody has read yet sorts LAST, not first. It used to sort first, because
 * "no reading" read as 0% used; that made a fresh login look better than a measured one
 * and is exactly the fail-open standing order 1 forbids. A measured account, however
 * busy, is preferred to an unmeasured one, and an unmeasured account is still picked
 * when it is all there is.
 *
 * `undefined` when no account of that provider is usable -- the caller then falls back
 * to the machine's own login, which is what every session used before accounts existed.
 */
export function pickAccount(
  accounts: AccountRecord[], usage: AccountUsage, live: Record<string, number>, now: number,
  provider: AccountProvider = 'claude', model?: string, mode: PickMode = 'worker',
): AccountRecord | undefined {
  const atCeiling = (account: AccountRecord): boolean => (
    account.maxConcurrent !== undefined && (live[account.id] ?? 0) >= account.maxConcurrent
  );
  const usable = accounts.filter((account) => (
    account.provider === provider && !isLimited(account.id, now, usage, model) && !atCeiling(account)
  ));
  if (usable.length === 0) return undefined;
  // Compared in order, first difference wins. Held-back accounts lose to every ordinary
  // one; among equals, a measured account beats an unmeasured one; then least used; then
  // fewest live runs; then the order they were connected.
  const rank = (account: AccountRecord): number[] => [
    heldBackRank(account, usage, now, model, mode),
    hasReading(account.id, usage) ? 0 : 1,
    hasReading(account.id, usage) ? usedFraction(account.id, now, usage, model) : 0,
    live[account.id] ?? 0,
  ];
  return usable.reduce((best, account) => {
    const here = rank(account);
    const there = rank(best);
    for (let i = 0; i < here.length; i += 1) {
      if (here[i]! < there[i]!) return account;
      if (here[i]! > there[i]!) return best;
    }
    return best;
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
  existsConfigDir?: (path: string) => boolean, provider: AccountProvider = 'claude', model?: string,
): { configDir: string | null; accountId: string | null } {
  const picked = pickAccount(accounts, usage, live, now, provider, model);
  if (picked) return { configDir: picked.configDir, accountId: picked.id };
  return { configDir: provider === 'claude' ? fleetConfigDir(existsConfigDir) : null, accountId: null };
}

/**
 * The config dir a launch path should pin, for the paths that cannot await a probe.
 *
 * These used to hardcode `fleetConfigDir()`, which pinned every worker, reasoner, MCP
 * runner and integrations probe to one account whatever the registry said. Selection
 * here reads the store as it stands rather than refreshing it: a reading `forge run` or
 * the console took minutes ago is a far better basis than "always this one account", and
 * these call sites are synchronous.
 *
 * Never throws and never returns empty: any trouble at all falls back to the machine's
 * own login, which is what every one of these paths did unconditionally before.
 */
export function workerConfigDir(
  model?: string,
  existsConfigDir?: (path: string) => boolean,
  provider: AccountProvider = 'claude',
  now: number = Date.now(),
): string {
  const fallback = fleetConfigDir(existsConfigDir);
  try {
    const picked = configDirForSession(
      loadAccounts(), readAccountUsage(), {}, now, existsConfigDir, provider, model,
    );
    return picked.configDir ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * The worst binding window of an account's last reading, or null when nothing has been
 * read. `usedFraction` deliberately cannot carry this: it returns a number, and a
 * sentence a person reads needs to name which window the number is about.
 */
export function worstWindow(
  account: string, now: number, usage: AccountUsage, model?: string,
): { label: string; usedPct: number } | null {
  const windows = usage[account]?.reading?.windows ?? [];
  let worst: { label: string; usedPct: number } | null = null;
  for (const window of windows) {
    if (window.resetsAt !== null && window.resetsAt <= now) continue;
    if (!windowBinds(window.key, model)) continue;
    if (!worst || window.usedPct > worst.usedPct) worst = { label: window.label, usedPct: window.usedPct };
  }
  return worst;
}

/** Rounded the way both implementations round: halfway goes up, in Python too, which
 *  `round()` there does not do. A percent that differs by one between the two languages
 *  is a sentence that differs, and the parity test is what would catch it. */
function percent(usedPct: number): number {
  return Math.floor(usedPct + 0.5);
}

/**
 * The one line a terminal prints before handing over to the real binary: which login it
 * chose and how full that login is, in words.
 *
 * Never an id, never a uuid, never a path -- Aaron reads this every time he opens a
 * terminal, and the only two things worth his attention are whose login he is on and
 * whether it is about to run out. `accounts.py` builds the identical sentence; the two
 * are tested against each other on two different percentages, so a hardcoded string
 * cannot pass for both.
 */
export function interactiveSentence(
  account: Pick<AccountRecord, 'id' | 'email' | 'label'>, now: number, usage: AccountUsage, model?: string,
): string {
  const name = accountName(account);
  const worst = worstWindow(account.id, now, usage, model);
  if (!worst) return `Using the ${name} login; its limits have not been read yet.`;
  return `Using the ${name} login, at ${percent(worst.usedPct)}% of its ${worst.label} limit.`;
}

/** What a freshly logged-in directory shares with the operator's, and what it must keep
 *  to itself. The junctions are the point: one transcript tree means a session started
 *  on one login resumes on another with no copying (proved on CLI 2.1.267 before any of
 *  this was built), and one hooks/skills/plugins tree means a second login is not a
 *  stripped-down machine. */
export const SEEDED_LINKS = ['projects', 'hooks', 'skills', 'plugins'] as const;
export const SEEDED_COPIES = ['settings.json', 'CLAUDE.md'] as const;

export type SeedResult =
  | { ok: true; created: string[]; skipped: string[] }
  | { ok: false; reason: string };

function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Gives a new login directory everything except the login: the operator's transcript,
 * hook, skill and plugin trees by junction, and copies of the two files that are read far
 * more often than they are written.
 *
 * Nothing is copied that is per-login -- `.credentials.json`, `.claude.json`, `sessions`,
 * `tasks`, `cache`, `daemon`, `shell-snapshots`, `session-env`, `backups`,
 * `history.jsonl` -- and `.credentials.json` in particular is never read, opened or
 * looked at by this function at all.
 *
 * **It never converts a directory that is already in use.** A real `projects/` folder
 * under the target means a live login with its own history, and turning that into a
 * junction would strand it. Such a directory is REFUSED, by name, and the operator is
 * given a written procedure to convert it by hand at a quiet moment. The check is on the
 * entries themselves, not on the parent: an empty target directory is fine, a target
 * with real content is not.
 */
export function seedConfigDir(dir: string, operatorDir: string): SeedResult {
  for (const name of SEEDED_LINKS) {
    if (isRealDirectory(join(dir, name))) {
      return { ok: false, reason: `${dir} already has a real ${name}/ directory; converting a login in use is a manual step, not this one` };
    }
  }
  mkdirSync(dir, { recursive: true });
  const created: string[] = [];
  const skipped: string[] = [];
  for (const name of SEEDED_LINKS) {
    const link = join(dir, name);
    if (existsSync(link)) { skipped.push(name); continue; }
    const target = join(operatorDir, name);
    if (!existsSync(target)) { skipped.push(name); continue; }
    // 'junction' is what Windows can make without an elevated process; everywhere else
    // node ignores the type and makes an ordinary directory symlink.
    symlinkSync(target, link, 'junction');
    created.push(name);
  }
  for (const name of SEEDED_COPIES) {
    const to = join(dir, name);
    if (existsSync(to)) { skipped.push(name); continue; }
    const from = join(operatorDir, name);
    if (!existsSync(from)) { skipped.push(name); continue; }
    copyFileSync(from, to);
    created.push(name);
  }
  return { ok: true, created, skipped };
}
