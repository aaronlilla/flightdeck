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
import { run as execRun, type RunRequest } from './exec.js';
import { forgeHome } from './paths.js';

export type ConnectState = 'connecting' | 'waiting-in-browser' | 'probing' | 'connected' | 'failed';

export interface ConnectAttempt {
  id: string;
  label: string;
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
  removeAccount: (id: string) => void;
  /** Fresh on every call -- never a cached count -- so disconnect's refusal is judged
   *  against the current fleet, not the fleet as it was when this class was built. */
  liveRunCount: (accountId: string) => number;
  /** Starts the account's browser login flow. Real callers spawn `claude` behind
   *  `exec.ts`'s injectable `run()`; every specimen here fakes this directly instead. */
  spawnLogin: (configDir: string) => Promise<LoginResult>;
  /** Confirms the account actually authenticated, via `claude auth status --json`
   *  behind the same spawn abstraction. */
  probeStatus: (configDir: string) => Promise<ProbeResult>;
  /** Runs `claude auth logout` under the account's own config dir. Disconnect calls this
   *  before touching the registry; a logout that fails leaves the row in place, since a
   *  removed row with a still-live credential on disk is worse than a stuck disconnect
   *  button. */
  logout: (configDir: string) => Promise<LogoutResult>;
  now?: () => number;
  randomId?: () => string;
}

export interface AccountsConnectOptions {
  /** Where a fresh account's own config directory lives, given its label and the id
   *  this attempt generated for it. Overridable so a specimen can force a collision
   *  without depending on this module's own naming scheme. */
  configDirFor?: (label: string, id: string) => string;
}

export type StartConnectResult =
  | { ok: true; attemptId: string }
  | { ok: false; error: string };

export type DisconnectResult =
  | { ok: true }
  | { ok: false; error: string };

function safeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]/g, '_') || 'account';
}

function defaultConfigDirFor(label: string, id: string): string {
  return join(forgeHome(), 'accounts', 'configs', `${safeLabel(label)}-${id}`);
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
export function realSpawnLogin(spawnFn?: RunRequest['spawnFn']): (configDir: string) => Promise<LoginResult> {
  return async (configDir: string) => {
    const result = await execRun({
      argv: ['claude', 'auth', 'login', '--claudeai'], cwd: process.cwd(), owner: 'accounts-connect-login', cls: 'script',
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      ...(spawnFn ? { spawnFn } : {}),
    });
    const link = LINK_PATTERN.exec(result.tail)?.[0];
    return {
      ok: result.returncode === 0,
      ...(link ? { link } : {}),
      ...(result.returncode !== 0 ? { error: `claude login exited ${result.returncode}: ${result.tail}` } : {}),
    };
  };
}

/** The real `probeStatus`: `claude auth status --json` under the candidate account's
 *  config directory, the only way this module ever confirms a login actually worked. */
export function realProbeStatus(spawnFn?: RunRequest['spawnFn']): (configDir: string) => Promise<ProbeResult> {
  return async (configDir: string) => {
    const result = await execRun({
      argv: ['claude', 'auth', 'status', '--json'], cwd: process.cwd(), owner: 'accounts-connect-probe', cls: 'script',
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      ...(spawnFn ? { spawnFn } : {}),
    });
    if (result.returncode !== 0) {
      return { ok: false, error: `claude auth status exited ${result.returncode}: ${result.tail}` };
    }
    return { ok: true };
  };
}

/** The real `logout`: `claude auth logout` under the account's own config directory.
 *  Disconnect runs this before it touches the registry at all. */
export function realLogout(spawnFn?: RunRequest['spawnFn']): (configDir: string) => Promise<LogoutResult> {
  return async (configDir: string) => {
    const result = await execRun({
      argv: ['claude', 'auth', 'logout'], cwd: process.cwd(), owner: 'accounts-connect-logout', cls: 'script',
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      ...(spawnFn ? { spawnFn } : {}),
    });
    if (result.returncode !== 0) {
      return { ok: false, error: `claude auth logout exited ${result.returncode}: ${result.tail}` };
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
  private readonly labelsInFlight = new Set<string>();

  private readonly configDirFor: (label: string, id: string) => string;

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

  startConnect(label: string): StartConnectResult {
    if (this.labelsInFlight.has(label)) {
      return { ok: false, error: `a connect attempt for "${label}" is already in flight` };
    }
    const id = this.randomId();
    const configDir = this.configDirFor(label, id);
    const collision = this.deps.loadAccounts().some((account) => account.configDir === configDir);
    if (collision) {
      return { ok: false, error: `config-dir collision for "${label}": ${configDir} is already in use` };
    }

    const attempt: ConnectAttempt = { id, label, state: 'connecting' };
    this.attempts.set(id, attempt);
    this.labelsInFlight.add(label);
    void this.runConnect(attempt, configDir);
    return { ok: true, attemptId: id };
  }

  private async runConnect(attempt: ConnectAttempt, configDir: string): Promise<void> {
    try {
      attempt.state = 'waiting-in-browser';
      const login = await this.deps.spawnLogin(configDir);
      if (login.link) attempt.link = login.link;
      if (!login.ok) {
        attempt.state = 'failed';
        attempt.error = login.error ?? 'login failed';
        return;
      }

      attempt.state = 'probing';
      const probe = await this.deps.probeStatus(configDir);
      if (!probe.ok) {
        attempt.state = 'failed';
        attempt.error = probe.error ?? 'probe failed: account did not authenticate';
        return;
      }

      const accountId = this.randomId();
      this.deps.addAccount({ id: accountId, label: attempt.label, configDir, connectedAt: this.now() });
      attempt.accountId = accountId;
      attempt.state = 'connected';
    } catch (error) {
      attempt.state = 'failed';
      attempt.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.labelsInFlight.delete(attempt.label);
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
      return { ok: false, error: `refusing to disconnect "${account.label}": ${live} run(s) still in flight on it` };
    }
    const logout = await this.deps.logout(account.configDir);
    if (!logout.ok) {
      return { ok: false, error: logout.error ?? `logout failed for "${account.label}"` };
    }
    this.deps.removeAccount(id);
    return { ok: true };
  }
}
