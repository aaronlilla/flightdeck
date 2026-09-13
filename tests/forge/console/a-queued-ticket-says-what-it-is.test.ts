import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Journal } from '../../../src/forge/journal.js';
import { QueueRoutes } from '../../../src/forge/console/queue-route.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import { TicketTitles } from '../../../src/forge/console/ticket-titles.js';
import type { QueueItem } from '../../../src/shared/console-model.js';

/**
 * A queued ticket names itself before anybody plans it.
 *
 * Aaron, 2026-09-13, after ingesting his board through the Add box: nineteen cards, and
 * every one of them read `Title not read yet` beside a bare key. A ticket card's title
 * came off the brief written for it, and a brief is not written until the item starts, so
 * a queue of nineteen waiting tickets was nineteen rows of nothing to read. The summaries
 * were one call away the whole time -- the same reader a ticket-key hover already uses.
 *
 * The read cannot happen on the way out of `GET /queue`: that answers a five-second poll,
 * and a blocking Jira call per item per poll would make the board slower the fuller it
 * gets. So the lookup is a cache filled in the background, and the card reads whatever the
 * cache knows this instant -- null until the first read lands, never a stall.
 */
describe('the titles behind a queue of ticket keys', () => {
  it('knows nothing before it is asked, rather than blocking to find out', () => {
    const titles = new TicketTitles({ read: async () => ({ summary: 'x' } as never) });
    expect(titles.get('BBZ-1')).toBeNull();
  });

  it('reads each key once, and answers from what it read', async () => {
    const read = vi.fn(async (key: string) => ({ summary: `summary of ${key}` } as never));
    const titles = new TicketTitles({ read });
    titles.want(['BBZ-1', 'BBZ-2', 'BBZ-1']);
    await titles.settled();
    expect(titles.get('BBZ-1')).toBe('summary of BBZ-1');
    expect(titles.get('BBZ-2')).toBe('summary of BBZ-2');
    titles.want(['BBZ-1']);
    await titles.settled();
    expect(read).toHaveBeenCalledTimes(2);
  });

  // A key the reader cannot answer for is asked again later -- a ticket moved into a
  // project the credentials can see, or a network blip. What it must never do is retry
  // on every poll: that is a call per card per five seconds against somebody's board.
  it('does not hammer a key it could not read', async () => {
    const read = vi.fn(async () => null);
    const titles = new TicketTitles({ read, retryAfterMs: 60_000, now: () => 1_000 });
    titles.want(['BBZ-9']);
    await titles.settled();
    titles.want(['BBZ-9']);
    await titles.settled();
    expect(read).toHaveBeenCalledTimes(1);
    expect(titles.get('BBZ-9')).toBeNull();
  });

  it('asks again once the wait is over', async () => {
    const read = vi.fn(async () => null);
    let clock = 1_000;
    const titles = new TicketTitles({ read, retryAfterMs: 60_000, now: () => clock });
    titles.want(['BBZ-9']);
    await titles.settled();
    clock += 60_001;
    titles.want(['BBZ-9']);
    await titles.settled();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('survives a reader that throws, and asks again after the wait', async () => {
    const read = vi.fn(async () => { throw new Error('jira said no'); });
    let clock = 0;
    const titles = new TicketTitles({ read, retryAfterMs: 10, now: () => clock });
    titles.want(['BBZ-9']);
    await expect(titles.settled()).resolves.toBeUndefined();
    expect(titles.get('BBZ-9')).toBeNull();
    clock += 11;
    titles.want(['BBZ-9']);
    await titles.settled();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('holds an empty summary as nothing to show, not as the string it came as', async () => {
    const titles = new TicketTitles({ read: async () => ({ summary: '   ' } as never) });
    titles.want(['BBZ-9']);
    await titles.settled();
    expect(titles.get('BBZ-9')).toBeNull();
  });
});

describe('the card an ingested board leaves on screen', () => {
  let dir: string;
  let store: QueueStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'queued-ticket-title-'));
    mkdirSync(join(dir, 'lanes'), { recursive: true });
    process.env['FORGE_HOME'] = dir;
    new Journal(join(dir, 'fleet.jsonl')).close();
    writeFileSync(join(dir, 'model-policy.json'), JSON.stringify({ version: 1, classes: {} }), 'utf8');
    store = new QueueStore(join(dir, 'queue.jsonl'));
  });

  function queued(ticket: string): void {
    const item: QueueItem = {
      id: `Q-${ticket}`, source: 'query', input: 'project = BBZ', ticket, repo: null,
      briefPath: null, branch: null, worktreePath: null, base: null,
      state: 'queued', reason: null, runKey: null, pr: null,
      journalIds: [], createdAt: 1, updatedAt: 1,
    } as unknown as QueueItem;
    store.append({ at: 1, ...item });
  }

  function routes(titles?: { get(k: string): string | null; want(k: Iterable<string>): void }): QueueRoutes {
    return new QueueRoutes({
      store, search: { searchKeys: async () => [] }, authorized: () => true,
      readPaused: () => false, writePaused: () => {}, maxInFlight: 2, publish: () => {},
      ...(titles ? { ticketTitles: titles } : {}),
    });
  }

  it('says what the ticket is, once its summary has been read', async () => {
    queued('BBZ-266');
    const titles = new TicketTitles({ read: async () => ({ summary: 'Wallet balance goes stale after a transfer' } as never) });
    const view = routes(titles);
    // First read: nothing is known yet, and the card must not stall waiting for it.
    expect((view.list()).items[0]?.title ?? null).toBeNull();
    await titles.settled();
    expect((view.list()).items[0]?.title).toBe('Wallet balance goes stale after a transfer');
  });

  it('asks about every key on the page, not only the first', async () => {
    queued('BBZ-1');
    queued('BBZ-2');
    const want = vi.fn();
    routes({ get: () => null, want }).list();
    expect(want).toHaveBeenCalledTimes(1);
    expect([...(want.mock.calls[0]?.[0] as string[])].sort()).toEqual(['BBZ-1', 'BBZ-2']);
  });

  it('still answers with no reader wired at all', async () => {
    queued('BBZ-3');
    expect(routes().list().items[0]?.title ?? null).toBeNull();
  });
});
