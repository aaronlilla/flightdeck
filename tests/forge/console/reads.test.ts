/**
 * `ConsoleReads`'s own wiring for the human-facing lane fields (H1.1): a lane's
 * `title`/`sourceUrl` come from whichever real source named it -- the queue item's
 * brief, a chain packet's brief, or a registered run's own briefPath -- read straight
 * off disk rather than invented.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Journal } from '../../../src/forge/journal.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import { Lanes } from '../../../src/forge/supervisor.js';
import { Registry } from '../../../src/forge/registry.js';
import { Inbox } from '../../../src/forge/inbox.js';
import { ConsoleReads } from '../../../src/forge/console/reads.js';
import { clock } from '../../../src/shared/humanize.js';

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
      // Without this the story reaches for the real `gh` to read PR #119, which is a
      // five-second timeout on a CI runner with no GitHub session.
      ghDetailLookup: async () => undefined,
    });

    const server = reads as unknown as { runStoryResponse(run: string): Promise<{ entries: Array<{ text: string }> }> };
    const story = await server.runStoryResponse('queue-BBZ-96');
    expect(story.entries.map((e) => e.text)).toContain(`Queued from Jira as BBZ-96 at ${clock(500)}`);
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
    // Deliverable 6: `labelFor` now prefers the ticket key over the title, so a lane
    // that carries one -- BBZ-99, here -- shows it on the rail chip.
    expect(chip?.text).toBe('BBZ-99: context ceiling reached, handed off to a fresh session.');
    expect(chip?.text).not.toMatch(/queue-|STUCK/i);
  });

  it('deliverable 6: a successor run\'s chip carries the root lane\'s own title, not its own bare id', () => {
    const forgeHomeDir = tempDir('console-reads-');
    const briefsDir = join(forgeHomeDir, 'briefs');
    mkdirSync(briefsDir, { recursive: true });
    const briefPath = join(briefsDir, 'hotfix-fee.md');
    writeFileSync(briefPath, '# fix the withdrawal fee\n', 'utf8');

    const queueStore = new QueueStore(join(forgeHomeDir, 'console', 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'hotfix', input: 'fix the withdrawal fee', ticket: null, repo: 'o/n',
      briefPath, branch: 'hotfix/fee', worktreePath: 'w', base: 'main',
      state: 'running', reason: null, runKey: 'hotfix-fee', pr: null, journalIds: [],
      createdAt: 1, updatedAt: 1,
    });

    const journalPath = join(forgeHomeDir, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'hotfix-fee', actor: 'runner' });
    journal.append({ event: 'run.handoff', run: 'hotfix-fee', actor: 'runner', successor: 'hotfix-fee-2' });
    journal.append({ event: 'run.started', run: 'hotfix-fee-2', actor: 'runner' });
    journal.append({ event: 'run.killed', run: 'hotfix-fee-2', actor: 'operator', reason: 'over budget' });
    journal.close();

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    lanes.put('hotfix-fee', { column: 'hotfix-fee' });

    const threadDir = join(forgeHomeDir, 'console');
    mkdirSync(threadDir, { recursive: true });
    writeFileSync(
      join(threadDir, 'thread.jsonl'),
      `${JSON.stringify({ k: 'm1', type: 'operator', text: 'hi', ts: 0, source: 'operator' })}\n`,
      'utf8',
    );

    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore,
      jiraSite: null,
    });

    const server = reads as unknown as { threadResponse(): { messages: Array<{ text: string }> } };
    const thread = server.threadResponse();
    const chip = thread.messages.find((m) => m.text.includes('killed'));
    expect(chip?.text).toContain('fix the withdrawal fee');
    expect(chip?.text).not.toMatch(/hotfix-fee-2/i);
  });

  // Item 8: an operator bubble that resumes a ticket-carrying lane echoed the lane's
  // full TITLE (a "Resume Close the fee-skip hole for card withdrawals with both fee
  // fields omitted (BBZ-182)." bubble on the live board) because the seam handed to
  // computeThread mapped every id straight to lane.title, skipping the ticket key
  // entirely. It must echo the short ticket key instead.
  it('item 8: an echoed command names a ticket-carrying lane by its ticket, not its long title', () => {
    const forgeHomeDir = tempDir('console-reads-');
    const briefsDir = join(forgeHomeDir, 'briefs');
    mkdirSync(briefsDir, { recursive: true });
    const briefPath = join(briefsDir, 'bbz-182.md');
    writeFileSync(briefPath, '# Close the fee-skip hole for card withdrawals with both fee fields omitted\n', 'utf8');

    const queueStore = new QueueStore(join(forgeHomeDir, 'console', 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'ticket', input: 'BBZ-182', ticket: 'BBZ-182', repo: 'o/n',
      briefPath, branch: 'feature/bbz-182', worktreePath: 'w', base: 'develop',
      state: 'running', reason: null, runKey: 'queue-BBZ-182', pr: null, journalIds: [],
      createdAt: 1, updatedAt: 1,
    });

    const journalPath = join(forgeHomeDir, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'queue-BBZ-182', actor: 'runner' });
    journal.close();

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    lanes.put('queue-BBZ-182', { column: 'BBZ-182' });

    const threadDir = join(forgeHomeDir, 'console');
    mkdirSync(threadDir, { recursive: true });
    writeFileSync(
      join(threadDir, 'thread.jsonl'),
      `${JSON.stringify({ k: 'm1', type: 'operator', text: 'resume queue-BBZ-182', ts: 1, source: 'operator' })}\n`,
      'utf8',
    );

    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore, jiraSite: null,
    });

    const server = reads as unknown as { threadResponse(): { messages: Array<{ text: string }> } };
    const thread = server.threadResponse();
    const operator = thread.messages.find((m) => m.text.startsWith('Resume'));
    expect(operator?.text).toBe('Resume BBZ-182.');
  });

  // Item 9: a queue item's own park `reason` can carry an unshortened 40-character
  // sha ("checks are failure on head <sha>, not green"); `plainForQueueItem` reads
  // that raw reason AFTER `computeLanes` already stripped and shortened `plain` once,
  // so the sha reached the board whole even though the tile's own sha read short.
  it('item 9: a queue-parked lane\'s plain sentence never carries a 40-character sha', () => {
    const forgeHomeDir = tempDir('console-reads-');
    const queueStore = new QueueStore(join(forgeHomeDir, 'console', 'queue.jsonl'));
    const sha = 'f284c653033e12549fdaa68212840987a328a824';
    queueStore.append({
      id: 'Q-1', at: 1, source: 'ticket', input: 'BBZ-1', ticket: 'BBZ-1', repo: 'o/n',
      briefPath: null, branch: 'feature/bbz-1', worktreePath: 'w', base: 'develop',
      state: 'parked', reason: `refused: checks are failure on head ${sha}, not green.`,
      runKey: 'queue-BBZ-1', pr: null, journalIds: [], createdAt: 1, updatedAt: 1,
    });

    const journalPath = join(forgeHomeDir, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'queue-BBZ-1', actor: 'runner' });
    journal.close();

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    lanes.put('queue-BBZ-1', { column: 'BBZ-1' });

    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore, jiraSite: null,
    });

    const [lane] = reads.lanesResponse().lanes;
    expect(lane!.plain).not.toContain(sha);
    expect(lane!.plain).toContain(sha.slice(0, 7));
  });

  it('item 7: GET /lanes reads a queue lane\'s checks/verdict/merged in the background, off repo+PR alone, with no chain packet at all', async () => {
    const forgeHomeDir = tempDir('console-reads-');
    const { writeAttestation } = await import('../../../src/forge/council/attest.js');
    writeAttestation({
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
      journalIds: [], createdAt: 1, updatedAt: 1,
    });

    const journalPath = join(forgeHomeDir, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'queue-BBZ-96', actor: 'runner' });
    journal.close();

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    lanes.put('queue-BBZ-96', { column: 'BBZ-96' });

    let ghCalls = 0;
    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore, jiraSite: null,
      mergeAllowed: (repo) => repo === 'o/n',
      ghDetailLookup: async (repo, pr) => {
        ghCalls += 1;
        expect(repo).toBe('o/n');
        expect(pr).toBe(119);
        return { headSha: 'deadbeef', isDraft: true, merged: false, title: 'add the merge chip', checks: 'success' };
      },
    });

    // First call: no `gh` read has ever landed for this lane, so it reads exactly what
    // the queue item itself carries -- no checks/verdict/merged yet -- and kicks a
    // detail read off in the background rather than blocking this response on `gh`.
    const first = reads.lanesResponse().lanes[0]!;
    expect(first.pr).toEqual({ no: 119, url: 'https://github.com/o/n/pull/119', files: 6, add: 360, del: 5, draft: true });
    expect(first.mergeable).toEqual({ ok: false, why: 'checks pending' });

    const server = reads as unknown as { settlePrRefreshes(): Promise<void> };
    await server.settlePrRefreshes();

    // Second call, after the background read has landed: checks, verdict and merged
    // are all filled in, and mergeable now says yes.
    const second = reads.lanesResponse().lanes[0]!;
    expect(second.pr).toEqual({
      no: 119, url: 'https://github.com/o/n/pull/119', files: 6, add: 360, del: 5, draft: true,
      checks: 'success', merged: false, title: 'add the merge chip', verdict: 'PASS WITH NOTES', mergedAt: null,
    });
    expect(second.mergeable).toEqual({ ok: true });
    expect(ghCalls).toBe(1);
  });

  // Item 11: the run itself opened a PR straight off its own branch, but nothing
  // ever wrote its number back onto the queue item -- the exact live-board finding
  // (PR #39 for `feature/s-b9d39bae548707e0`, self lane still reading "no PR yet").
  it('item 11: a queue item with no PR on record discovers one by branch, and surfaces it exactly like a recorded PR', async () => {
    const forgeHomeDir = tempDir('console-reads-');
    const queueStore = new QueueStore(join(forgeHomeDir, 'console', 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'ticket', input: 'S-b9d39bae548707e0', ticket: null, repo: 'o/n',
      briefPath: null, branch: 'feature/s-b9d39bae548707e0', worktreePath: 'w', base: 'main',
      state: 'running', reason: null, runKey: 'S-b9d39bae548707e0', pr: null, journalIds: [],
      createdAt: 1, updatedAt: 1,
    });

    const journalPath = join(forgeHomeDir, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'S-b9d39bae548707e0', actor: 'runner' });
    journal.close();

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    lanes.put('S-b9d39bae548707e0', { column: 'self' });

    let branchCalls = 0;
    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore, jiraSite: null,
      ghBranchLookup: async (repo, branch) => {
        branchCalls += 1;
        expect(repo).toBe('o/n');
        expect(branch).toBe('feature/s-b9d39bae548707e0');
        return {
          number: 39, url: 'https://github.com/o/n/pull/39', isDraft: true, mergedAt: null,
          title: 'dedupe warden.health on an open unregistered trip', headRefOid: 'f284c65',
        };
      },
    });

    // First call: nothing has looked this PR up by branch yet, so the lane still
    // reads no PR -- and a background discovery is kicked off rather than blocking.
    const first = reads.lanesResponse().lanes[0]!;
    expect(first.pr).toBeNull();

    const server = reads as unknown as { settlePrRefreshes(): Promise<void> };
    await server.settlePrRefreshes();

    const second = reads.lanesResponse().lanes[0]!;
    expect(second.pr).toEqual({
      no: 39, url: 'https://github.com/o/n/pull/39', draft: true, merged: false,
      title: 'dedupe warden.health on an open unregistered trip', mergedAt: null,
    });
    expect(branchCalls).toBe(1);
  });

  it('item 7: GET /run/:id/pr answers for a queue lane with no chain packet, off the queue item\'s own repo and PR', async () => {
    const forgeHomeDir = tempDir('console-reads-');
    const queueStore = new QueueStore(join(forgeHomeDir, 'console', 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'ticket', input: 'BBZ-96', ticket: 'BBZ-96', repo: 'o/n',
      briefPath: null, branch: 'feature/bbz-96', worktreePath: 'w', base: 'develop',
      state: 'review', reason: null, runKey: 'queue-BBZ-96',
      pr: { no: 119, url: 'https://github.com/o/n/pull/119', files: 6, add: 360, del: 5, draft: true },
      journalIds: [], createdAt: 1, updatedAt: 1,
    });

    const journalPath = join(forgeHomeDir, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'queue-BBZ-96', actor: 'runner' });
    journal.close();

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    lanes.put('queue-BBZ-96', { column: 'BBZ-96' });

    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore, jiraSite: null,
      ghDetailLookup: async () => ({
        headSha: 'deadbeef', isDraft: true, merged: false, title: 'add the merge chip', checks: 'success',
      }),
      attestationReader: () => ({ verdict: 'PASS WITH NOTES' }),
    });

    const server = reads as unknown as { runPrResponse(run: string): Promise<{ pr: unknown }> };
    const result = await server.runPrResponse('queue-BBZ-96');
    expect(result.pr).toEqual({
      no: 119, url: 'https://github.com/o/n/pull/119', files: 6, add: 360, del: 5, draft: true,
      checks: 'success', merged: false, title: 'add the merge chip', verdict: 'PASS WITH NOTES', mergedAt: null,
    });
  });

  // Item 1: PR #39 merged at 01:57 while its queue item still read parked (refused,
  // checks failing on an old head) -- the live tile kept saying PARKED with a stale
  // reason instead of the one fact that actually settled it: the PR landed.
  it('item 1: a merged PR outranks a parked queue item -- the lane reads merged, not parked', async () => {
    const forgeHomeDir = tempDir('console-reads-');
    const queueStore = new QueueStore(join(forgeHomeDir, 'console', 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'hotfix', input: 'S-b9d39bae548707e0', ticket: null, repo: 'aaronlilla/flightdeck',
      briefPath: null, branch: 'feature/s-b9d39bae548707e0', worktreePath: 'w', base: 'develop',
      state: 'parked', reason: 'refused: checks are failure on head f284c65, not green.',
      runKey: 'S-b9d39bae548707e0',
      pr: { no: 39, url: 'https://github.com/aaronlilla/flightdeck/pull/39', draft: false },
      journalIds: [], createdAt: 1, updatedAt: 1,
    });

    const journalPath = join(forgeHomeDir, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'S-b9d39bae548707e0', actor: 'runner' });
    journal.append({ event: 'run.parked', run: 'S-b9d39bae548707e0', actor: 'warden', reason: 'refused: checks are failure on head f284c65, not green.' });
    journal.close();

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    lanes.put('S-b9d39bae548707e0', { column: 'self' });

    const mergedAt = Date.UTC(2026, 8, 8, 1, 57);
    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore, jiraSite: null,
      mergeAllowed: () => true,
      ghDetailLookup: async () => ({
        headSha: 'f284c65', isDraft: false, merged: true, title: 'dedupe warden.health on an open unregistered trip',
        checks: 'failure', mergedAt,
      }),
    });

    // Before the background PR-detail read lands, the queue item's own parked state
    // still stands -- only once the merged fact arrives does it outrank it.
    const first = reads.lanesResponse().lanes[0]!;
    expect(first.state).toBe('parked');
    const server = reads as unknown as { settlePrRefreshes(): Promise<void> };
    await server.settlePrRefreshes();

    const merged = reads.lanesResponse().lanes[0]!;
    expect(merged.state).toBe('merged');
    expect(merged.reason).toBeNull();
    expect(merged.plain).toBe(`Merged: PR #39 landed at ${clock(mergedAt)}.`);
    expect(merged.you).toBe('Nothing needed; it merged. Clean up retires it.');
    expect(merged.mergeable).toEqual({ ok: false, why: 'already merged' });
  });

  // The other half of item 1's own specimen pair: a parked queue item whose PR is
  // still open reads parked exactly as before -- only a merged PR outranks it.
  it('item 1: a parked queue item with an open (unmerged) PR still reads parked', async () => {
    const forgeHomeDir = tempDir('console-reads-');
    const queueStore = new QueueStore(join(forgeHomeDir, 'console', 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'hotfix', input: 'S-open', ticket: null, repo: 'aaronlilla/flightdeck',
      briefPath: null, branch: 'feature/s-open', worktreePath: 'w', base: 'develop',
      state: 'parked', reason: 'refused: checks are failure on head abc1234, not green.',
      runKey: 'S-open', pr: { no: 40, url: 'https://github.com/aaronlilla/flightdeck/pull/40', draft: false },
      journalIds: [], createdAt: 1, updatedAt: 1,
    });

    const journalPath = join(forgeHomeDir, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'S-open', actor: 'runner' });
    journal.append({ event: 'run.parked', run: 'S-open', actor: 'warden', reason: 'refused: checks are failure on head abc1234, not green.' });
    journal.close();

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    lanes.put('S-open', { column: 'self' });

    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore, jiraSite: null,
      mergeAllowed: () => true,
      ghDetailLookup: async () => ({
        headSha: 'abc1234', isDraft: false, merged: false, title: 'still open', checks: 'failure', mergedAt: null,
      }),
    });

    reads.lanesResponse();
    const server = reads as unknown as { settlePrRefreshes(): Promise<void> };
    await server.settlePrRefreshes();

    const still = reads.lanesResponse().lanes[0]!;
    expect(still.state).toBe('parked');
    expect(still.reason).toBe('refused: checks are failure on head abc1234, not green.');
  });
});

describe('ConsoleReads.runSummaryResponse / runRecheckResponse (2026-09-07)', () => {
  let previousForgeHome: string | undefined;

  afterEach(() => {
    if (previousForgeHome === undefined) delete process.env['FORGE_HOME'];
    else process.env['FORGE_HOME'] = previousForgeHome;
  });

  function setup(): { forgeHomeDir: string; queueStore: QueueStore; journalPath: string } {
    const forgeHomeDir = tempDir('console-reads-summary-');
    previousForgeHome = process.env['FORGE_HOME'];
    process.env['FORGE_HOME'] = forgeHomeDir;
    const queueStore = new QueueStore(join(forgeHomeDir, 'console', 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'ticket', input: 'BBZ-96', ticket: 'BBZ-96', repo: 'o/n',
      briefPath: null, branch: 'feature/bbz-96', worktreePath: 'w', base: 'develop',
      state: 'review', reason: null, runKey: 'queue-BBZ-96',
      pr: { no: 119, url: 'https://github.com/o/n/pull/119', draft: true },
      journalIds: [], createdAt: 500, updatedAt: 1_500,
    });
    const journalPath = join(forgeHomeDir, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'queue-BBZ-96', actor: 'runner' });
    journal.close();
    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    lanes.put('queue-BBZ-96', { column: 'BBZ-96' });
    return { forgeHomeDir, queueStore, journalPath };
  }

  it('GET /run/:id/summary folds the PR title, checks, the attestation and drift into one summary', async () => {
    const { forgeHomeDir, queueStore, journalPath } = setup();
    const { writeAttestation } = await import('../../../src/forge/council/attest.js');
    writeAttestation({
      repo: 'o/n', pr: 119, head: 'deadbeef', base: 'develop', round: 1, verdict: 'PASS WITH NOTES',
      decidingFindings: [{
        member: 'style', file: 'src/console/api.ts', line: 1, claim: 'a nit',
        failureScenario: 'cosmetic only', severity: 'low', confidence: 'high',
      }],
      lenses: [], judge: { model: 'sonnet-5', verdict: 'PASS WITH NOTES' },
      ci: { runId: 'r1', headSha: 'deadbeef' }, at: { value: 42, observed_at: 42 },
      coverage: { total: 4, missing: [] },
    } as never);

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore, jiraSite: null,
      ghDetailLookup: async () => ({
        headSha: 'deadbeef', isDraft: true, merged: false, title: 'add the merge chip',
        checks: 'success', body: 'Wires the merge chip into the sheet.',
      }),
      driftFn: async () => ({ behindBase: 0, headMoved: false }),
      gitLog: async () => [],
      mergeAllowed: () => true,
    });

    const summary = await reads.runSummaryResponse('queue-BBZ-96');
    expect(summary.what).toContain('add the merge chip.');
    expect(summary.audit).toMatchObject({ verdict: 'PASS WITH NOTES', reviewed: 4, total: 4, findings: 1, stale: false });
    expect(summary.readiness).toMatchObject({ ok: true, checks: 'success', headMoved: false, behindBase: 0 });
  });

  it('POST /run/:id/recheck drops the shared PR cache entry before recomputing', async () => {
    const { forgeHomeDir, queueStore, journalPath } = setup();
    const { writePrCache, prCachePath } = await import('../../../src/forge/console/pr.js');
    const cachePath = prCachePath(forgeHomeDir);
    writePrCache(cachePath, { 'queue-BBZ-96': { pr: { no: 119, url: 'stale', draft: false }, at: Date.now() } });

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore, jiraSite: null,
      ghDetailLookup: async () => ({
        headSha: 'freshsha', isDraft: false, merged: false, title: 'add the merge chip', checks: 'pending',
      }),
      driftFn: async () => ({ behindBase: null, headMoved: false }),
      gitLog: async () => [],
    });

    await reads.runRecheckResponse('queue-BBZ-96');
    // Dropping the stale entry lets the board's own background refresh (fired the moment
    // `runSummaryResponse` reads the lane) write a fresh one back in -- this proves the
    // stale `url: 'stale'` row is gone and the fresh checks read landed, not that the
    // cache key stays empty forever.
    const { readPrCache } = await import('../../../src/forge/console/pr.js');
    const cached = readPrCache(cachePath)['queue-BBZ-96'];
    expect(cached?.pr?.url).not.toBe('stale');
    expect(cached?.pr?.checks).toBe('pending');
  });

  // Item 2: the summary must answer fast on a warm cache and never repeat a `gh`/`git`
  // call it already made moments ago -- `runSummaryResponse` used to call
  // `ghDetailLookup` twice in a single request (once through `runStoryResponse`, once
  // for its own fresh read) and again on every re-open within the same 60s, which is
  // the live console's own 11-second sheet.
  it('caches the PR detail and drift reads for 60s, never re-invoking gh within the window', async () => {
    const { forgeHomeDir, queueStore, journalPath } = setup();
    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    let ghCalls = 0;
    let driftCalls = 0;
    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore, jiraSite: null,
      ghDetailLookup: async () => {
        ghCalls += 1;
        return {
          headSha: 'deadbeef', isDraft: true, merged: false, title: 'add the merge chip',
          checks: 'success', body: 'Wires the merge chip into the sheet.',
        };
      },
      driftFn: async () => { driftCalls += 1; return { behindBase: 0, headMoved: false }; },
      gitLog: async () => [],
      mergeAllowed: () => true,
    });

    await reads.runSummaryResponse('queue-BBZ-96');
    // `lanesResponse` (which `runSummaryResponse` reads the lane through) can fire its
    // own background PR-detail refresh (item 7) alongside the summary's own read -- a
    // separate concern from this one, so it is flushed and counted once before the
    // real assertion: a second `runSummaryResponse` call inside the 60s window adds no
    // further `gh`/`git` calls of its own.
    await reads.settlePrRefreshes();
    const ghAfterFirst = ghCalls;
    const driftAfterFirst = driftCalls;
    expect(ghAfterFirst).toBeGreaterThan(0);
    expect(driftAfterFirst).toBeGreaterThan(0);

    await reads.runSummaryResponse('queue-BBZ-96');
    await reads.settlePrRefreshes();
    expect(ghCalls).toBe(ghAfterFirst);
    expect(driftCalls).toBe(driftAfterFirst);
  });
});

describe('ConsoleReads.lanesResponse: archived bypasses the 24h finished-lane window', () => {
  it('a lane retired well outside the 24h window still lists on lanesResponse(false, true)', async () => {
    const forgeHomeDir = tempDir('console-reads-archived-');
    const journalPath = join(forgeHomeDir, 'fleet.jsonl');
    const longAgo = Date.now() - (48 * 60 * 60 * 1000);
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'beta', actor: 'runner', at: longAgo });
    journal.append({
      event: 'run.finished', run: 'beta', actor: 'runner', verdict: 'done', at: longAgo,
    });
    journal.close();

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    lanes.put('beta', { column: 'c2' });

    // Retiring straight through the on-disk log (not the HTTP route), so the retire
    // itself never journals a fresh event that would keep the lane looking recently
    // observed -- the real bug this specimen catches is the window filtering an old,
    // already-retired lane out before the archived filter runs, not a fresh timestamp
    // papering over the window.
    const { retireRun, retiredPath } = await import('../../../src/forge/console/retire.js');
    retireRun(retiredPath(forgeHomeDir), 'beta', longAgo + 1000);

    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore: new QueueStore(join(forgeHomeDir, 'console', 'queue.jsonl')), jiraSite: null,
    });

    const notArchived = reads.lanesResponse(false, false);
    expect(notArchived.lanes.map((l) => l.id)).not.toContain('beta');

    const archived = reads.lanesResponse(false, true);
    expect(archived.lanes.map((l) => l.id)).toContain('beta');
  });
});

describe('ConsoleReads.runStoryResponse: story scoping (deliverable 1)', () => {
  it('never matches a packet-less lane against other packet-less rows in the journal', async () => {
    const forgeHomeDir = tempDir('console-reads-story-scope-');
    const journalPath = join(forgeHomeDir, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'S-self1', actor: 'runner' });
    for (let i = 0; i < 50; i += 1) {
      journal.append({ event: 'run.parked', run: `S-other${i}`, actor: 'runner', reason: `park ${i}` });
    }
    journal.close();

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    lanes.put('S-self1', { column: 'S-self1' });

    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore: new QueueStore(join(forgeHomeDir, 'console', 'queue.jsonl')),
      jiraSite: null, gitLog: async () => [],
    });

    const server = reads as unknown as { runStoryResponse(run: string): Promise<{ entries: Array<{ text: string; kind: string }> }> };
    const story = await server.runStoryResponse('S-self1');
    const parkEntries = story.entries.filter((e) => e.kind === 'park' || e.text.includes('park'));
    expect(parkEntries).toHaveLength(0);
  });

  it('passes the git log function the queue item\'s own base and created time as a range', async () => {
    const forgeHomeDir = tempDir('console-reads-story-range-');
    const journalPath = join(forgeHomeDir, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'queue-BBZ-1', actor: 'runner' });
    journal.close();

    const queueStore = new QueueStore(join(forgeHomeDir, 'console', 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'ticket', input: 'BBZ-1', ticket: 'BBZ-1', repo: 'o/n',
      briefPath: null, branch: 'feature/bbz-1', worktreePath: forgeHomeDir, base: 'develop',
      state: 'running', reason: null, runKey: 'queue-BBZ-1', pr: null, journalIds: [],
      createdAt: 4_000, updatedAt: 4_000,
    });

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    lanes.put('queue-BBZ-1', { column: 'BBZ-1' });

    let seenRange: { base: string | null; since: number } | undefined;
    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore, jiraSite: null,
      gitLog: async (_worktreePath: string, range?: { base: string | null; since: number }) => {
        seenRange = range;
        return [];
      },
    });

    const server = reads as unknown as { runStoryResponse(run: string): Promise<unknown> };
    await server.runStoryResponse('queue-BBZ-1');
    expect(seenRange).toEqual({ base: 'develop', since: 4_000 });
  });
});

describe('ConsoleReads: run thread verbose wiring (deliverable 7)', () => {
  it('plain by default, verbose only when the caller\'s own private call asks for it', () => {
    const forgeHomeDir = tempDir('console-reads-verbose-');
    const journalPath = join(forgeHomeDir, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.close();

    const lanes = new Lanes(join(forgeHomeDir, 'lanes'));
    lanes.put('alpha', { column: 'alpha' });

    const reads = new ConsoleReads({
      forgeHomeDir, journalPath, lanes, registry: new Registry(join(forgeHomeDir, 'registry')),
      inbox: new Inbox(join(forgeHomeDir, 'inbox')), queueStore: new QueueStore(join(forgeHomeDir, 'console', 'queue.jsonl')),
      jiraSite: null,
    });

    const server = reads as unknown as {
      runThreadResponse(run: string, verbose?: boolean): { messages: Array<{ text: string }>; verbose?: boolean };
    };
    const plain = server.runThreadResponse('alpha');
    expect(plain.verbose).toBeUndefined();
    expect(plain.messages.some((m) => m.text === 'alpha started')).toBe(false);

    const verbose = server.runThreadResponse('alpha', true);
    expect(verbose.verbose).toBe(true);
    expect(verbose.messages.some((m) => m.text === 'alpha started')).toBe(true);
  });
});
