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
import { JiraWatcher, readWatcherState, writeWatcherState } from '../../../src/forge/sync/watcher-state.js';

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
