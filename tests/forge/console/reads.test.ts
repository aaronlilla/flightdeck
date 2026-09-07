/**
 * `ConsoleReads`'s own wiring for the human-facing lane fields (H1.1): a lane's
 * `title`/`sourceUrl` come from whichever real source named it -- the queue item's
 * brief, a chain packet's brief, or a registered run's own briefPath -- read straight
 * off disk rather than invented.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Journal } from '../../../src/forge/journal.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import { Lanes } from '../../../src/forge/supervisor.js';
import { Registry } from '../../../src/forge/registry.js';
import { Inbox } from '../../../src/forge/inbox.js';
import { ConsoleReads } from '../../../src/forge/console/reads.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('ConsoleReads.lanesResponse: title and sourceUrl', () => {
  it('titles a ticket lane off its queue item\'s brief and links Jira by key', () => {
    const forgeHomeDir = tempDir('console-reads-');
    const briefsDir = join(forgeHomeDir, 'briefs');
    mkdirSync(briefsDir, { recursive: true });
    const briefPath = join(briefsDir, 'BBZ-96.md');
    writeFileSync(briefPath, '# BBZ-96: add the merge chip\n\nbody text\n', 'utf8');

    const queueStore = new QueueStore(join(forgeHomeDir, 'console', 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'ticket', input: 'BBZ-96', ticket: 'BBZ-96', repo: 'o/n',
      briefPath, branch: 'feature/bbz-96', worktreePath: 'w', base: 'develop',
      state: 'running', reason: null, runKey: 'queue-BBZ-96', pr: null, journalIds: [],
      createdAt: 1, updatedAt: 1,
    });

    const journalPath = join(forgeHomeDir, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'queue-BBZ-96', actor: 'runner' });
    journal.close();

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    lanes.put('queue-BBZ-96', { column: 'BBZ-96' });

    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore, jiraSite: 'https://x.atlassian.net',
    });

    const [lane] = reads.lanesResponse().lanes;
    expect(lane!.title).toBe('add the merge chip');
    expect(lane!.sourceUrl).toBe('https://x.atlassian.net/browse/BBZ-96');
  });

  it('titles a manual lane off its registered brief, with no source link', () => {
    const forgeHomeDir = tempDir('console-reads-');
    const briefPath = join(forgeHomeDir, 'ad-hoc.md');
    writeFileSync(briefPath, '# a one-off CLI run\n', 'utf8');

    const journalPath = join(forgeHomeDir, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.close();

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    lanes.put('alpha', { column: 'alpha' });

    const registry = new Registry(join(forgeHomeDir, 'registry'));
    registry.admit({ goal: 'alpha', cwd: '.', briefPath, pid: 1 });

    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry,
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore: new QueueStore(join(forgeHomeDir, 'console', 'queue.jsonl')),
      jiraSite: null,
    });

    const [lane] = reads.lanesResponse().lanes;
    expect(lane!.title).toBe('a one-off CLI run');
    expect(lane!.sourceUrl).toBeNull();
  });

  it('mergeable reads the queue\'s own merge allow-list for the lane\'s repo (H1.4)', () => {
    const forgeHomeDir = tempDir('console-reads-');
    const journalPath = join(forgeHomeDir, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.append({ event: 'run.finished', run: 'alpha', actor: 'runner', verdict: 'done' });
    journal.close();

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    lanes.put('alpha', { column: 'alpha' });

    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore: new QueueStore(join(forgeHomeDir, 'console', 'queue.jsonl')),
      jiraSite: null, mergeAllowed: () => false,
    });

    const [lane] = reads.lanesResponse().lanes;
    // No PR at all is the reason that actually applies here, and outranks the
    // allow-list check -- there is nothing yet for the allow-list to refuse.
    expect(lane!.mergeable).toEqual({ ok: false, why: 'no PR yet' });
  });

  it('titles a probe lane with no lookup at all', () => {
    const forgeHomeDir = tempDir('console-reads-');
    const journalPath = join(forgeHomeDir, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'forge-live-probe-1', actor: 'runner' });
    journal.close();

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    lanes.put('forge-live-probe-1', { column: 'probe' });

    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore: new QueueStore(join(forgeHomeDir, 'console', 'queue.jsonl')),
      jiraSite: null,
    });

    const [lane] = reads.lanesResponse().lanes;
    expect(lane!.title).toBe('Live probe of the runner');
    expect(lane!.sourceUrl).toBeNull();
  });
});
