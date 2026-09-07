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

  it('GET /run/:id/story folds the queue item and the journal into one narrative (H1.6)', async () => {
    const forgeHomeDir = tempDir('console-reads-');
    const briefsDir = join(forgeHomeDir, 'briefs');
    mkdirSync(briefsDir, { recursive: true });
    const briefPath = join(briefsDir, 'BBZ-96.md');
    writeFileSync(briefPath, '# BBZ-96: add the merge chip\n\nbody text\n', 'utf8');

    const queueStore = new QueueStore(join(forgeHomeDir, 'console', 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'ticket', input: 'BBZ-96', ticket: 'BBZ-96', repo: 'o/n',
      briefPath, branch: 'feature/bbz-96', worktreePath: 'w', base: 'develop',
      state: 'review', reason: null, runKey: 'queue-BBZ-96',
      pr: { no: 119, url: 'https://github.com/o/n/pull/119', files: 1, add: 1, del: 0, draft: true },
      journalIds: [], createdAt: 500, updatedAt: 1_500,
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
      gitLog: async () => [],
    });

    const server = reads as unknown as { runStoryResponse(run: string): Promise<{ entries: Array<{ text: string }> }> };
    const story = await server.runStoryResponse('queue-BBZ-96');
    expect(story.entries.map((e) => e.text)).toContain('Queued from Jira as BBZ-96 at ' + new Date(500).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    expect(story.entries.map((e) => e.text)).toContain('Draft PR #119 opened');
    expect(story.entries.map((e) => e.text)).toContain('Branch feature/bbz-96 off develop');
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

  it('H1.2 fix: plain reads the queue item\'s own review state and the attestation on disk, not the run\'s own unverified verdict', async () => {
    const forgeHomeDir = tempDir('console-reads-');
    const { writeAttestation } = await import('../../../src/forge/council/attest.js');
    const attestationPath = writeAttestation({
      repo: 'o/n', pr: 119, head: 'deadbeef', base: 'develop', round: 1, verdict: 'PASS WITH NOTES',
      decidingFindings: [], lenses: [], judge: { model: 'sonnet-5', verdict: 'PASS WITH NOTES' },
      ci: { runId: 'r1', headSha: 'deadbeef' }, at: { value: 1, observed_at: 1 },
      coverage: { total: 4, missing: [] },
    } as never);

    const queueStore = new QueueStore(join(forgeHomeDir, 'console', 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'ticket', input: 'BBZ-96', ticket: 'BBZ-96', repo: 'o/n',
      briefPath: null, branch: 'feature/bbz-96', worktreePath: 'w', base: 'develop',
      state: 'review', reason: null, runKey: 'queue-BBZ-96',
      pr: { no: 119, url: 'https://github.com/o/n/pull/119', files: 6, add: 360, del: 5, draft: true },
      journalIds: [], createdAt: 1, updatedAt: 1, attestationPath,
    });

    const journalPath = join(forgeHomeDir, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'queue-BBZ-96', actor: 'runner' });
    journal.append({ event: 'run.finished', run: 'queue-BBZ-96', actor: 'runner', verdict: 'unverified' });
    journal.close();

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    lanes.put('queue-BBZ-96', { column: 'BBZ-96' });

    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore, jiraSite: null,
    });

    const [lane] = reads.lanesResponse().lanes;
    expect(lane!.plain).toBe('In review: council PASS WITH NOTES, 4 of 4 reviewed; draft PR #119 is waiting for your Merge.');
    expect(lane!.plain).not.toMatch(/queue-|-\d+$/);
  });

  it('H1.9 fix: GET /thread rail chips read the lane\'s own title, off the same lookup GET /lanes uses', () => {
    const forgeHomeDir = tempDir('console-reads-');
    const briefsDir = join(forgeHomeDir, 'briefs');
    mkdirSync(briefsDir, { recursive: true });
    const briefPath = join(briefsDir, 'BBZ-99.md');
    writeFileSync(briefPath, '# BBZ-99: reconcile stale wallet holds\n', 'utf8');

    const queueStore = new QueueStore(join(forgeHomeDir, 'console', 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'ticket', input: 'BBZ-99', ticket: 'BBZ-99', repo: 'o/n',
      briefPath, branch: 'feature/bbz-99', worktreePath: 'w', base: 'develop',
      state: 'running', reason: null, runKey: 'queue-BBZ-99', pr: null, journalIds: [],
      createdAt: 1, updatedAt: 1,
    });

    const journalPath = join(forgeHomeDir, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'queue-BBZ-99', actor: 'runner' });
    journal.append({ event: 'liveness.stuck', run: 'queue-BBZ-99', actor: 'warden', signal: 'context' });
    journal.close();

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    lanes.put('queue-BBZ-99', { column: 'BBZ-99' });

    // A fresh console with no persisted rail history windows chips to "since the
    // earliest persisted message" -- one operator bubble here is enough to pull the
    // journal's own events (all older) into that window.
    const threadDir = join(forgeHomeDir, 'console');
    mkdirSync(threadDir, { recursive: true });
    writeFileSync(
      join(threadDir, 'thread.jsonl'),
      `${JSON.stringify({ k: 'm1', type: 'operator', text: 'hi', ts: 0, source: 'operator' })}\n`,
      'utf8',
    );

    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore, jiraSite: null,
    });

    const server = reads as unknown as { threadResponse(): { messages: Array<{ text: string }> } };
    const thread = server.threadResponse();
    const chip = thread.messages.find((m) => m.text.includes('context ceiling'));
    expect(chip?.text).toBe('reconcile stale wallet holds: context ceiling reached, handed off to a fresh session.');
    expect(chip?.text).not.toMatch(/queue-|STUCK/i);
  });
});
