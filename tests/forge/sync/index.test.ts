/**
 * R-68: the production stage wiring. Only `watcher-on`'s persistence is covered here
 * (/code-review medium finding) -- the other stages are exercised through `run.test.ts`
 * and `jira-pull.test.ts` with injected fakes; this file proves the one stage that
 * writes to disk on its own actually does.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import { Journal } from '../../../src/forge/journal.js';
import { buildProductionSyncStages } from '../../../src/forge/sync/index.js';
import { JiraWatcher, readWatcherState } from '../../../src/forge/sync/watcher-state.js';

let dir: string;
let originalForgeHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-index-'));
  originalForgeHome = process.env['FORGE_HOME'];
  process.env['FORGE_HOME'] = dir;
});

afterEach(() => {
  if (originalForgeHome === undefined) delete process.env['FORGE_HOME'];
  else process.env['FORGE_HOME'] = originalForgeHome;
});

describe('buildProductionSyncStages: watcher-on', () => {
  it('persists watcher.json the same way POST /watcher/on does', async () => {
    const queueStore = new QueueStore(join(dir, 'console', 'queue.jsonl'));
    const journal = new Journal(join(dir, 'fleet.jsonl'));
    const watcher = new JiraWatcher({
      jiraConfig: () => undefined,
      watermarks: { get: () => ({ source: 'jira', committedAt: 0, idsAtCommittedAt: [] }), set: () => {} },
      store: queueStore, journal,
    });
    process.env['FORGE_BACKLOG_PROJECT'] = 'BBZ';
    const { stages } = buildProductionSyncStages({ queueStore, watcher, journal });

    await stages['watcher-on']!({ now: Date.now });
    journal.close();

    expect(readWatcherState()).toEqual({ on: true, project: 'BBZ' });
    delete process.env['FORGE_BACKLOG_PROJECT'];
  });
});
