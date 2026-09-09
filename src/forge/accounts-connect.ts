/**
 * Connecting and disconnecting a Claude account from the console.
 *
 * A connect attempt is `connecting -> waiting-in-browser -> probing -> connected`, or
 * `failed` at either of the two steps that can fail. Every step goes through an
 * injected function (`spawnLogin`, `probeStatus`); nothing here spawns `claude` itself,
 * so a specimen never opens a real login flow. The one label a caller gives becomes a
 * single-flight guard: a second `startConnect` for the same label while the first is
 * still running is refused outright rather than racing it.
 *
 * The captured browser link and any auth error text live only on the `ConnectAttempt`
 * object this module hands back to whoever polls `getAttempt` -- never journaled,
 * published on a slice event, or logged, since a link an operator has not yet clicked
 * is exactly the kind of thing that should not sit in a shared file.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { AccountRecord } from './accounts.js';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

import { accountName, type AccountProvider } from './accounts.js';
import { identityOnDisk } from './accounts-probe.js';
import { run as execRun, type RunRequest } from './exec.js';
import { forgeHome } from './paths.js';

export type ConnectState = 'connecting' | 'waiting-in-browser' | 'probing' | 'connected' | 'failed';

export interface ConnectAttempt {
  id: string;
  provider: AccountProvider;
  state: ConnectState;
  link?: string;
  error?: string;
  accountId?: string;
}

export interface LoginResult {
  ok: boolean;
  link?: string;
  error?: string;
}

export interface ProbeResult {
  /** `subscriptionType` from the probe body (`max`, `pro`, `team`), when it said one. */
  plan?: string;
  /** The email the login is under, when the probe said one. */
  email?: string;
  ok: boolean;
  error?: string;
}

export interface LogoutResult {
  ok: boolean;
  error?: string;
}

export interface AccountsConnectDeps {
  loadAccounts: () => AccountRecord[];
  addAccount: (record: AccountRecord) => void;
  /** Records the plan the probe reported, so Settings can show it. Optional: a
   *  specimen that does not care about the plan leaves it unset. */
  recordPlan?: (accountId: string, plan: string, now: number) => void;
  removeAccount: (id: string) => void;
  /** Fresh on every call -- never a cached count -- so disconnect's refusal is judged
   *  against the current fleet, not the fleet as it was when this class was built. */
  liveRunCount: (accountId: string) => number;
  /** Starts the account's browser login flow. Real callers spawn `claude` behind
   *  `exec.ts`'s injectable `run()`; every specimen here fakes this directly instead. */
  spawnLogin: (provider: AccountProvider, configDir: string) => Promise<LoginResult>;
  /** Confirms the account actually authenticated, via `claude auth status --json`
   *  behind the same spawn abstraction. */
  probeStatus: (provider: AccountProvider, configDir: string) => Promise<ProbeResult>;
  /** Runs `claude auth logout` under the account's own config dir. Disconnect calls this
   *  before touching the registry; a logout that fails leaves the row in place, since a
   *  removed row with a still-live credential on disk is worse than a stuck disconnect
   *  button. */
  logout: (provider: AccountProvider, configDir: string) => Promise<LogoutResult>;
  now?: () => number;
  randomId?: () => string;
}

export interface AccountsConnectOptions {
  /** Where a fresh account's own config directory lives, given its label and the id
   *  this attempt generated for it. Overridable so a specimen can force a collision
   *  without depending on this module's own naming scheme. */
  configDirFor?: (provider: AccountProvider, id: string) => string;
}

export type StartConnectResult =
  | { ok: true; attemptId: string }
  | { ok: false; error: string };

export type DisconnectResult =
  | { ok: true }
  | { ok: false; error: string };

function defaultConfigDirFor(provider: AccountProvider, id: string): string {
  return join(forgeHome(), 'accounts', 'configs', `${provider}-${id}`);
}

/** The Codex binary: `CODEX_BIN` when set, else the standard install, else `codex` on PATH. */
export function codexBinary(): string {
  const fromEnv = process.env['CODEX_BIN'];
  if (fromEnv) return fromEnv;
  const installed = join(homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  return existsSync(installed) ? installed : 'codex';
}

function loginEnv(provider: AccountProvider, configDir: string): NodeJS.ProcessEnv {
  return provider === 'codex'
    ? { ...process.env, CODEX_HOME: configDir }
    : { ...process.env, CLAUDE_CONFIG_DIR: configDir };
}

const LINK_PATTERN = /https?:\/\/\S+/;

/**
 * The real `spawnLogin`: `claude login`, under the candidate account's own config
 * directory, through `exec.ts`'s injectable `run()` -- never `child_process` directly,
 * per the standing rule that a real `claude auth login` process only ever spawns behind
 * that one abstraction. A human still has to finish the browser flow this starts; this
 * function's own job ends once the process exits (or the browser link is on stdout) --
 * completing that flow live is out of scope for this wiring.
 */
export function realSpawnLogin(spawnFn?: RunRequest['spawnFn']): (provider: AccountProvider, configDir: string) => Promise<LoginResult> {
  return async (provider: AccountProvider, configDir: string) => {
    mkdirSync(configDir, { recursive: true });
    const argv = provider === 'codex' ? [codexBinary(), 'login'] : ['claude', 'auth', 'login', '--claudeai'];
    const result = await execRun({
      argv, cwd: process.cwd(), owner: 'accounts-connect-login', cls: 'script',
      env: loginEnv(provider, configDir),
      ...(spawnFn ? { spawnFn } : {}),
    });
    const link = LINK_PATTERN.exec(result.tail)?.[0];
    return {
      ok: result.returncode === 0,
      ...(link ? { link } : {}),
      ...(result.returncode !== 0 ? { error: `${provider} login exited ${result.returncode}: ${result.tail}` } : {}),
    };
  };
}

/** The real `probeStatus`: `claude auth status --json` under the candidate account's
 *  config directory, the only way this module ever confirms a login actually worked. */
export function realProbeStatus(spawnFn?: RunRequest['spawnFn']): (provider: AccountProvider, configDir: string) => Promise<ProbeResult> {
  return async (provider: AccountProvider, configDir: string) => {
    if (provider === 'codex') {
      // A Codex login is confirmed by the tokens it wrote, no process needed: the id
      // token names the email and the plan.
      const who = identityOnDisk('codex', configDir);
      return who.email ? { ok: true, ...who } : { ok: false, error: 'codex login left no auth.json under its home' };
    }
    const result = await execRun({
      argv: ['claude', 'auth', 'status', '--json'], cwd: process.cwd(), owner: 'accounts-connect-probe', cls: 'script',
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      ...(spawnFn ? { spawnFn } : {}),
    });
    if (result.returncode !== 0) {
      return { ok: false, error: `claude auth status exited ${result.returncode}: ${result.tail}` };
    }
    return { ok: true, ...identityFrom(result.tail) };
  };
}

/** `subscriptionType` and `email` out of a `claude auth status --json` body. */
export function identityFrom(text: string): { plan?: string; email?: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { subscriptionType?: unknown; email?: unknown };
    return {
      ...(typeof parsed.subscriptionType === 'string' ? { plan: parsed.subscriptionType } : {}),
      ...(typeof parsed.email === 'string' ? { email: parsed.email } : {}),
    };
  } catch {
    return {};
  }
}

/** `subscriptionType` alone, for callers that only want the plan. */
export function planFrom(text: string): string | undefined {
  return identityFrom(text).plan;
}

/** The real `logout`: `claude auth logout` under the account's own config directory.
 *  Disconnect runs this before it touches the registry at all. */
export function realLogout(spawnFn?: RunRequest['spawnFn']): (provider: AccountProvider, configDir: string) => Promise<LogoutResult> {
  return async (provider: AccountProvider, configDir: string) => {
    const result = await execRun({
      argv: provider === 'codex' ? [codexBinary(), 'logout'] : ['claude', 'auth', 'logout'], cwd: process.cwd(), owner: 'accounts-connect-logout', cls: 'script',
      env: loginEnv(provider, configDir),
      ...(spawnFn ? { spawnFn } : {}),
    });
    if (result.returncode !== 0) {
      return { ok: false, error: `${provider} logout exited ${result.returncode}: ${result.tail}` };
    }
    return { ok: true };
  };
}

export class AccountsConnect {
  private readonly attempts = new Map<string, ConnectAttempt>();

  /** Labels with a connect attempt currently in flight -- the single-flight guard.
   *  In-memory rather than `credential-horizon.ts`'s file lock: that lock already
   *  carries a different lifecycle (a lapsed login's `onLapse`/`tick`, tied to
   *  `notifyAaron` and a blocker board), and a fresh connect attempt only ever needs to
   *  keep two clicks in the same console session from racing each other. */
  private readonly providersInFlight = new Set<AccountProvider>();

  private readonly configDirFor: (provider: AccountProvider, id: string) => string;

  constructor(private readonly deps: AccountsConnectDeps, options: AccountsConnectOptions = {}) {
    this.configDirFor = options.configDirFor ?? defaultConfigDirFor;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private randomId(): string {
    return this.deps.randomId?.() ?? randomUUID();
  }

  getAttempt(id: string): ConnectAttempt | undefined {
    return this.attempts.get(id);
  }

  startConnect(provider: AccountProvider): StartConnectResult {
    if (this.providersInFlight.has(provider)) {
      return { ok: false, error: `a ${provider} login is already in progress` };
    }
    const id = this.randomId();
    const configDir = this.configDirFor(provider, id);
    const collision = this.deps.loadAccounts().some((account) => account.configDir === configDir);
    if (collision) {
      return { ok: false, error: `config-dir collision: ${configDir} is already in use` };
    }

    const attempt: ConnectAttempt = { id, provider, state: 'connecting' };
    this.attempts.set(id, attempt);
    this.providersInFlight.add(provider);
    void this.runConnect(attempt, configDir);
    return { ok: true, attemptId: id };
  }

  private async runConnect(attempt: ConnectAttempt, configDir: string): Promise<void> {
    try {
      attempt.state = 'waiting-in-browser';
      const login = await this.deps.spawnLogin(attempt.provider, configDir);
      if (login.link) attempt.link = login.link;
      if (!login.ok) {
        attempt.state = 'failed';
        attempt.error = login.error ?? 'login failed';
        return;
      }

      attempt.state = 'probing';
      const probe = await this.deps.probeStatus(attempt.provider, configDir);
      if (!probe.ok) {
        attempt.state = 'failed';
        attempt.error = probe.error ?? 'probe failed: account did not authenticate';
        return;
      }

      const same = probe.email
        ? this.deps.loadAccounts().find((account) => account.provider === attempt.provider && account.email === probe.email)
        : undefined;
      if (same) {
        attempt.state = 'failed';
        attempt.error = `${probe.email} is already linked`;
        return;
      }
      const accountId = this.randomId();
      this.deps.addAccount({
        id: accountId, provider: attempt.provider, label: probe.email ?? attempt.provider,
        ...(probe.email ? { email: probe.email } : {}), configDir, connectedAt: this.now(),
      });
      if (probe.plan) this.deps.recordPlan?.(accountId, probe.plan, this.now());
      attempt.accountId = accountId;
      attempt.state = 'connected';
    } catch (error) {
      attempt.state = 'failed';
      attempt.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.providersInFlight.delete(attempt.provider);
    }
  }

  /**
   * Removes an account. Refuses to remove the last one left, and refuses to remove one
   * with a run currently attributed to it -- both re-checked against `loadAccounts()`
   * and `liveRunCount()` fresh on this call, never against a count taken earlier, so a
   * caller working through several accounts one at a time gets the right answer on the
   * one that turns out to be last.
   */
  async disconnect(id: string): Promise<DisconnectResult> {
    const accounts = this.deps.loadAccounts();
    if (accounts.length <= 1) {
      return { ok: false, error: 'refusing to disconnect the last remaining account' };
    }
    const account = accounts.find((a) => a.id === id);
    if (!account) {
      return { ok: false, error: `no account "${id}"` };
    }
    const live = this.deps.liveRunCount(id);
    if (live > 0) {
      return { ok: false, error: `refusing to disconnect "${accountName(account)}": ${live} run(s) still in flight on it` };
    }
    const logout = await this.deps.logout(account.provider, account.configDir);
    if (!logout.ok) {
      return { ok: false, error: logout.error ?? `logout failed for "${accountName(account)}"` };
    }
    this.deps.removeAccount(id);
    return { ok: true };
  }
}
