/**
 * R-68 item 1: the watcher's on-disk state file and the `JiraWatcher` engine that
 * `POST /watcher/on|off` and `cli.ts`'s boot both drive.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PollSourceName, Watermark } from '../../../src/forge/contracts.js';
import type { WatermarkStore } from '../../../src/forge/intake/once.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import { initialWatermark } from '../../../src/forge/intake/watermark.js';
import { Journal } from '../../../src/forge/journal.js';
import { JiraWatcher, readWatcherState, shouldAutoStartWatcher, writeWatcherState } from '../../../src/forge/sync/watcher-state.js';

function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'watcher-state-')), name);
}

function memoryWatermarks(): WatermarkStore {
  const marks = new Map<PollSourceName, Watermark>();
  return {
    get: (source) => marks.get(source) ?? initialWatermark(source),
    set: (source, mark) => { marks.set(source, mark); },
  };
}

describe('readWatcherState / writeWatcherState', () => {
  it('round-trips on then off through the file', () => {
    const path = tempPath('watcher.json');
    expect(readWatcherState(path)).toEqual({ on: false, project: null });

    writeWatcherState({ on: true, project: 'BBZ' }, path);
    expect(readWatcherState(path)).toEqual({ on: true, project: 'BBZ' });

    writeWatcherState({ on: false, project: 'BBZ' }, path);
    expect(readWatcherState(path)).toEqual({ on: false, project: 'BBZ' });
  });

  it('a missing file reads as off with no project', () => {
    expect(readWatcherState(tempPath('missing.json'))).toEqual({ on: false, project: null });
  });
});

describe('shouldAutoStartWatcher (/code-review medium finding)', () => {
  it('a never-written state file falls back to FORGE_BACKLOG_PROJECT being set', () => {
    expect(shouldAutoStartWatcher(false, { on: false, project: null }, 'BBZ')).toBe(true);
    expect(shouldAutoStartWatcher(false, { on: false, project: null }, undefined)).toBe(false);
  });

  it('once the file exists, its own on flag wins even with the env var still set', () => {
    // The exact regression: POST /watcher/off wrote {on:false}, but the env var that
    // started it in the first place is still set in the shell/service environment.
    expect(shouldAutoStartWatcher(true, { on: false, project: 'BBZ' }, 'BBZ')).toBe(false);
    expect(shouldAutoStartWatcher(true, { on: true, project: 'BBZ' }, undefined)).toBe(true);
  });
});

describe('JiraWatcher', () => {
  let store: QueueStore;
  let journal: Journal;
  let calls: number;

  beforeEach(() => {
    store = new QueueStore(tempPath('queue.jsonl'));
    journal = new Journal(tempPath('journal.jsonl'));
    calls = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    journal.close?.();
    vi.useRealTimers();
  });

  function watcherWithFakeFeed(pollSeconds: number): JiraWatcher {
    return new JiraWatcher({
      jiraConfig: () => ({ site: 's', email: 'e', token: 't', fetchFn: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ issues: [], isLast: true }), { status: 200 });
      }) as typeof fetch }),
      watermarks: memoryWatermarks(),
      store,
      journal,
      pollSeconds,
    });
  }

  it('start observes exactly one poll and status().lastPollAt moves', async () => {
    const watcher = watcherWithFakeFeed(30);
    expect(watcher.status().lastPollAt).toBeUndefined();

    await watcher.start('BBZ');

    expect(calls).toBe(1);
    expect(watcher.status().lastPollAt).toBeDefined();
    expect(watcher.status().on).toBe(true);
    watcher.stop();
  });

  it('stop clears the interval: no second poll after fake time advances', async () => {
    const watcher = watcherWithFakeFeed(30);
    await watcher.start('BBZ');
    expect(calls).toBe(1);

    watcher.stop();
    expect(watcher.status().on).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toBe(1);
  });

  it('without stop, the interval polls again after pollSeconds', async () => {
    const watcher = watcherWithFakeFeed(30);
    await watcher.start('BBZ');
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(calls).toBe(2);
    watcher.stop();
  });
});

describe('JiraWatcher and the Jira feed (R-101)', () => {
  let store: QueueStore;
  let journal: Journal;

  beforeEach(() => {
    store = new QueueStore(tempPath('queue.jsonl'));
    journal = new Journal(tempPath('journal.jsonl'));
  });

  function config(issues: unknown[] = []) {
    return () => ({ site: 's', email: 'e', token: 't', fetchFn: (async () => new Response(JSON.stringify({ issues, isLast: true }), { status: 200 })) as typeof fetch });
  }

  const empty = { considered: 0, replied: [], deferred: [], sent: [], ignored: [], failed: [], answered: [] };

  it('runs the feed after each poll, resets it only on a fresh start, and never overlaps two passes', async () => {
    let release: () => void = () => undefined;
    const run = vi.fn(() => new Promise<typeof empty>((resolve) => { release = () => resolve(empty); }));
    const reset = vi.fn();
    const watcher = new JiraWatcher({ jiraConfig: config(), watermarks: memoryWatermarks(), store, journal, pollSeconds: 5, activity: { run, reset } });

    await watcher.start('ABC');
    expect(reset).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);

    await watcher.start('ABC');
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await watcher.settled();

    await watcher.start('ABC', { fresh: true });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
    release();
    await watcher.settled();
    watcher.stop();
  });

  it('shows a feed failure on the status line', async () => {
    const run = vi.fn(async () => { throw new Error('Jira 401'); });
    const watcher = new JiraWatcher({ jiraConfig: config(), watermarks: memoryWatermarks(), store, journal, pollSeconds: 5, activity: { run, reset: vi.fn() } });
    await watcher.start('ABC');
    await watcher.settled();
    expect(watcher.status().lastError).toBe('Jira 401');
    watcher.stop();
  });

  it('nudges the queue when a poll queues a ticket, and not when it queues none', async () => {
    const nudge = vi.fn();
    const quiet = new JiraWatcher({ jiraConfig: config(), watermarks: memoryWatermarks(), store, journal, pollSeconds: 5 });
    quiet.onTicketsAdded(nudge);
    await quiet.start('ABC');
    quiet.stop();
    expect(nudge).not.toHaveBeenCalled();

    const busy = new JiraWatcher({
      jiraConfig: config([{ key: 'ABC-7', fields: { summary: 's', status: { name: 'Backlog' }, updated: '2026-09-14T10:00:00.000+0000' } }]),
      watermarks: memoryWatermarks(), store, journal, pollSeconds: 5,
    });
    busy.onTicketsAdded(nudge);
    await busy.start('ABC');
    busy.stop();
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(store.all().map((item) => item.ticket)).toEqual(['ABC-7']);
  });
});

describe('JiraWatcher on a ticket poller thread (R-101)', () => {
  it('hands the poll to the poller, answers at once, and folds each result into status, the queue nudge and the comment pass', async () => {
    const store = new QueueStore(tempPath('queue.jsonl'));
    const journal = new Journal(tempPath('journal.jsonl'));
    let onPolled: ((result: { at: number; count: number; addedTickets: string[]; error?: string }) => void) | undefined;
    let running = false;
    const poller = {
      start: vi.fn((_project: string, fn: typeof onPolled) => { onPolled = fn; running = true; }),
      stop: vi.fn(() => { running = false; }),
      get running() { return running; },
    };
    const run = vi.fn(async () => ({ considered: 0, replied: [], deferred: [], sent: [], ignored: [], failed: [], answered: [] }));
    const fetchFn = vi.fn();
    const watcher = new JiraWatcher({
      jiraConfig: () => ({ site: 's', email: 'e', token: 't', fetchFn: fetchFn as never }),
      watermarks: memoryWatermarks(), store, journal, pollSeconds: 5,
      poller: poller as never, activity: { run, reset: vi.fn() },
    });
    const nudge = vi.fn();
    watcher.onTicketsAdded(nudge);

    await watcher.start('ABC');
    expect(poller.start).toHaveBeenCalledWith('ABC', expect.any(Function));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(watcher.status().on).toBe(true);

    onPolled!({ at: 1234, count: 1, addedTickets: ['ABC-9'] });
    expect(watcher.status().lastPollAt).toBe(1234);
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    await watcher.settled();

    onPolled!({ at: 2000, count: 0, addedTickets: [], error: 'Jira 401' });
    expect(watcher.status().lastError).toBe('Jira 401');
    expect(nudge).toHaveBeenCalledTimes(1);

    watcher.stop();
    expect(poller.stop).toHaveBeenCalled();
    expect(watcher.status().on).toBe(false);
  });
});

// Measured live 2026-09-14: a burst of comments waited 6-8 s before the feed started on
// them, because the comment pass only ran after a ticket poll result arrived.
describe('the comment pass keeps its own short cadence (R-101)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('runs on its own interval with no ticket poll result, and stops with the watcher', async () => {
    vi.useFakeTimers();
    const store = new QueueStore(tempPath('queue.jsonl'));
    const journal = new Journal(tempPath('journal.jsonl'));
    const poller = { start: vi.fn(), stop: vi.fn(), get running() { return true; } };
    const run = vi.fn(async () => ({ considered: 0, replied: [], deferred: [], sent: [], ignored: [], failed: [], answered: [] }));
    const watcher = new JiraWatcher({
      jiraConfig: () => ({ site: 's', email: 'e', token: 't' }), watermarks: memoryWatermarks(), store, journal,
      pollSeconds: 5, feedSeconds: 2, poller: poller as never, activity: { run, reset: vi.fn() },
    });

    await watcher.start('ABC');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(3);

    watcher.stop();
    const afterStop = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.mock.calls.length).toBe(afterStop);
  });
});
