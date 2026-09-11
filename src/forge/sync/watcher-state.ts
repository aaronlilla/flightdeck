/**
 * R-68 item 1: the Jira watcher's runtime on/off switch (`~/.forge/console/watcher.json`,
 * `watcherStatePath()`) and the engine that owns its interval. Before this file the
 * watcher could only start at `forge up`'s own boot, from `FORGE_BACKLOG_PROJECT` -- this
 * is what lets `POST /watcher/on` start it later, from the console, with no restart.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { WatcherStatus } from '../../shared/sync-contract.js';
import type { JiraConfig } from '../intake/jira.js';
import type { WatermarkStore } from '../intake/once.js';
import type { QueueStore } from '../intake/queueStore.js';
import { readWatcherPollSeconds, watcherFeed, watcherJql, watcherTick } from '../intake/watcherWire.js';
import type { Journal } from '../journal.js';
import { watcherStatePath } from '../paths.js';

export { watcherJql };

export interface WatcherFileState {
  on: boolean;
  project: string | null;
}

const BLANK_STATE: WatcherFileState = { on: false, project: null };

export function readWatcherState(path: string = watcherStatePath()): WatcherFileState {
  if (!existsSync(path)) return { ...BLANK_STATE };
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<WatcherFileState>;
    return { on: data.on === true, project: data.project ?? null };
  } catch {
    return { ...BLANK_STATE };
  }
}

export function writeWatcherState(state: WatcherFileState, path: string = watcherStatePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state), 'utf8');
}

/**
 * `cli.ts`'s boot decision, pulled out so it is testable without spinning up `forge up`.
 * Once `watcher.json` exists at all, its own `on` flag is authoritative -- an explicit
 * `POST /watcher/off` must stay off across a restart even while `FORGE_BACKLOG_PROJECT`
 * is still set in the environment (the ordinary case: nothing unsets that env var when a
 * person flips the switch from the console). Only a machine that has never written the
 * file falls back to the old "env var is set" rule, so a fresh install with no watcher
 * history keeps its prior boot-only behavior.
 */
export function shouldAutoStartWatcher(
  stateFileExists: boolean, state: WatcherFileState, envProject: string | undefined,
): boolean {
  return stateFileExists ? state.on : Boolean(envProject);
}

export interface JiraWatcherDeps {
  jiraConfig: () => JiraConfig | undefined;
  watermarks: WatermarkStore;
  store: QueueStore;
  journal: Journal;
  pollSeconds?: number;
  now?: () => number;
}

/**
 * Owns the interval `cli.ts`'s boot block used to own inline. `start`/`stop` are the
 * production side of `POST /watcher/on|off`; `status()` is what `/state.watcher` and
 * `GET /sync` both read. One poll runs immediately on `start`, same as the old inline
 * `setInterval` callback firing on its first real tick -- a click on "watcher on"
 * shouldn't wait a full `pollSeconds` for its first result.
 */
export class JiraWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;

  private project: string | null = null;

  private readonly pollSeconds: number;

  private readonly now: () => number;

  private lastPollAt: number | undefined;

  private lastCount: number | undefined;

  private lastError: string | undefined;

  constructor(private readonly deps: JiraWatcherDeps) {
    this.pollSeconds = deps.pollSeconds ?? readWatcherPollSeconds();
    this.now = deps.now ?? Date.now;
  }

  private async pollOnce(project: string): Promise<void> {
    const config = this.deps.jiraConfig();
    if (!config) {
      this.lastError = 'no Jira credentials';
      return;
    }
    try {
      const result = await watcherTick({
        feedFor: (ownedKeys) => watcherFeed(project, config, ownedKeys),
        watermarks: this.deps.watermarks,
        store: this.deps.store,
        journal: this.deps.journal,
        now: this.now,
      });
      this.lastPollAt = this.now();
      this.lastCount = result.addedTickets.length + result.sends.length + result.closed.length;
      this.lastError = undefined;
    } catch (error) {
      this.lastPollAt = this.now();
      this.lastError = error instanceof Error ? error.message : String(error);
      this.deps.journal.append({
        event: 'watcher.tick-error', actor: 'watcher', message: this.lastError,
      } as never);
    }
  }

  /** Starts polling `project`. Awaiting it means the first poll has already happened;
   *  production callers (`cli.ts`, `POST /watcher/on`) can also fire-and-forget. */
  async start(project: string): Promise<void> {
    this.stop();
    this.project = project;
    await this.pollOnce(project);
    this.timer = setInterval(() => { void this.pollOnce(project); }, this.pollSeconds * 1000);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  status(): WatcherStatus {
    return {
      on: this.timer !== undefined,
      project: this.project,
      pollSeconds: this.pollSeconds,
      ...(this.lastPollAt !== undefined
        ? { lastPollAt: this.lastPollAt, nextPollAt: this.lastPollAt + this.pollSeconds * 1000 }
        : {}),
      ...(this.lastCount !== undefined ? { lastCount: this.lastCount } : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }
}
