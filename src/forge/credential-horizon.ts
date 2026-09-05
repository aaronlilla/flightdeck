/**
 * One login flow in flight per account, ever.
 *
 * "A `/login` on a loop's account is a blocker key" and "single-flight" is the roadmap's
 * word for one login in flight per account, others parking behind it rather than each
 * starting their own flow. The lock is a file rather than an in-memory flag, because the
 * run that hits the lapse and the run that already started the flow are two different
 * `forge run` processes: `~/.forge/logins/<account>.lock` holds the `Incarnation` (pid
 * plus start time) of whoever is running the flow, and a lock whose pid is gone is stale
 * and free to take.
 *
 * Never a secret in the lock file, the Aaron-facing message, or the journal: the message
 * goes through `Redact` before it leaves this module, the same as every other sink.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BlockerBoard } from './blockers.js';
import { redact as defaultRedact, type Redact } from './contracts.js';
import type { Journal } from './journal.js';
import { loginsDir } from './paths.js';

export interface Incarnation {
  pid: number;
  startedAt: number;
}

function safeAccount(account: string): string {
  return account.replace(/[^A-Za-z0-9._-]/g, '_');
}

function lockPath(account: string): string {
  return join(loginsDir(), `${safeAccount(account)}.lock`);
}

export function readLoginLock(account: string): Incarnation | undefined {
  const path = lockPath(account);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Incarnation;
  } catch {
    return undefined;
  }
}

/**
 * Take the lock for `account`, or refuse because a live holder already has it.
 *
 * A lock whose pid `isAlive` reports gone is stale: it is overwritten rather than
 * blocking forever behind a process that no longer exists.
 */
export function acquireLoginLock(
  account: string, incarnation: Incarnation, isAlive: (pid: number) => boolean,
): boolean {
  const held = readLoginLock(account);
  if (held && isAlive(held.pid)) return false;
  mkdirSync(loginsDir(), { recursive: true });
  writeFileSync(lockPath(account), JSON.stringify(incarnation, null, 2), 'utf8');
  return true;
}

export function releaseLoginLock(account: string): void {
  const path = lockPath(account);
  if (existsSync(path)) rmSync(path);
}

export interface CredentialHorizonDeps {
  journal: Journal;
  blockers: BlockerBoard;
  /** Sends Aaron the one message naming the page or link. Never a secret value. */
  notifyAaron: (message: string) => void;
  /** Starts the provider's own browser flow (`aws sso login`, `gh auth login --web`,
   *  `claude login`, an MCP authorize link) and returns the page or link to show Aaron. */
  startFlow: (account: string) => Promise<{ page: string }>;
  isAlive?: (pid: number) => boolean;
  redact?: Redact;
}

export type LapseOutcome = 'started' | 'parked';

export class CredentialHorizon {
  /** How many times this account has been re-notified while its flow is still open,
   *  capped so a lapse that never resolves nags Aaron at most twice before it stays a
   *  console-only block. */
  private readonly askCounts = new Map<string, number>();

  constructor(private readonly deps: CredentialHorizonDeps) {}

  /**
   * A lapse just happened on `account` for `run`. Starts the one flow this account gets,
   * or parks behind whoever already started it.
   */
  async onLapse(account: string, run: string, incarnation: Incarnation): Promise<LapseOutcome> {
    const isAlive = this.deps.isAlive ?? (() => true);
    const acquired = acquireLoginLock(account, incarnation, isAlive);
    if (!acquired) {
      await this.deps.blockers.raise(`credential:${account}`, `login lapse on ${account}`, run);
      return 'parked';
    }

    const { page } = await this.deps.startFlow(account);
    const redact = this.deps.redact ?? defaultRedact;
    this.askCounts.set(account, 1);
    this.deps.notifyAaron(redact(
      `credential horizon: ${account} needs a fresh login. Open: ${page}`,
    ));
    this.deps.journal.append({
      event: 'note', run, actor: 'warden', note: `single-flight login started for ${account}`,
    });
    return 'started';
  }

  /**
   * A second nudge while the flow is still open. Silent past two asks total: the block
   * stays visible on the console rather than repeating itself at Aaron forever.
   */
  remind(account: string, page: string): boolean {
    const asked = this.askCounts.get(account) ?? 0;
    if (asked >= 2) return false;
    const redact = this.deps.redact ?? defaultRedact;
    this.askCounts.set(account, asked + 1);
    this.deps.notifyAaron(redact(`credential horizon: still waiting on ${account}. Open: ${page}`));
    return true;
  }

  /**
   * Called on the cadence while a flow is open for `account`. Once the provider's own
   * probe reports the credential valid again, the lock releases and every run parked
   * behind `credential:<account>` resumes in the order it arrived.
   */
  async tick(account: string, probeValid: () => boolean | Promise<boolean>): Promise<boolean> {
    const valid = await probeValid();
    if (!valid) return false;
    releaseLoginLock(account);
    this.askCounts.delete(account);
    await this.deps.blockers.clear(`credential:${account}`, 'credentials refreshed; carry on');
    return true;
  }
}
