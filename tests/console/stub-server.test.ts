import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createStubServer, resetStubDb } from '../../src/console/stub-server.js';

let server: Server;
let base: string;

beforeEach(async () => {
  resetStubDb();
  server = createStubServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`);
  return (await response.json()) as T;
}

async function post<T>(path: string, body: unknown = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as T };
}

describe('stub server', () => {
  it('serves the 15-lane board with one lane per state (plus a third-repo lane)', async () => {
    const { lanes } = await get<{ lanes: { state: string }[] }>('/lanes');
    expect(lanes.length).toBe(15);
    const states = new Set(lanes.map((l) => l.state));
    expect(states).toContain('running');
    expect(states).toContain('parked');
    expect(states).toContain('merged');
  });

  // POLISH-2 #4: the real /lanes?all=1 route lands server-side in parallel; the stub
  // must not break on the query it doesn't otherwise act on.
  it('accepts the all=1 query on /lanes without erroring', async () => {
    const { lanes } = await get<{ lanes: { state: string }[] }>('/lanes?all=1');
    expect(lanes.length).toBe(15);
  });

  it('kills a run and journals it', async () => {
    const { status, body } = await post<{ ok: boolean; jid: string }>('/run/FLT-201/kill', { reason: 'operator' });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const { lanes } = await get<{ lanes: { id: string; state: string }[] }>('/lanes');
    expect(lanes.find((l) => l.id === 'FLT-201')?.state).toBe('killed');
  });

  it('refuses a per-run cap above the hard limit', async () => {
    const { status, body } = await post<{ error: string; hardTokens: number }>('/run/FLT-201/cap', { tokenCap: 99_000_000 });
    expect(status).toBe(422);
    expect(body.hardTokens).toBe(20_000_000);
  });

  // Sweep #20: this used to capture only the leading digits off a typed cap and drop
  // any k/m suffix, so "raise daily cap to 2m tokens" set the cap to a literal 2
  // tokens instead of 2,000,000.
  it('parses a k/m token suffix the same way the real command grammar does', async () => {
    const { body } = await post<{ cards: { type: string; text: string }[] }>('/command', { text: 'raise daily cap to 2m tokens' });
    const receipt = body.cards.find((c) => c.type === 'receipt');
    expect(receipt?.text).toContain('2.0M');
    const caps = await get<{ dailyTokens: number }>('/caps');
    expect(caps.dailyTokens).toBe(2_000_000);
  });

  it('parses a k/m token suffix on a per-lane cap command the same way', async () => {
    const { body } = await post<{ cards: { type: string; text: string }[] }>('/command', { text: 'cap FLT-201 at 500k tokens' });
    const receipt = body.cards.find((c) => c.type === 'receipt');
    expect(receipt?.text).toContain('500k');
    const { lanes } = await get<{ lanes: { id: string; tokenCap: number | null }[] }>('/lanes');
    expect(lanes.find((l) => l.id === 'FLT-201')?.tokenCap).toBe(500_000);
  });

  it('answers the parked lane through the command grammar and resumes it', async () => {
    const { body } = await post<{ cards: { type: string }[] }>('/command', { text: 'answer nullable + backfill' });
    expect(body.cards.some((c) => c.type === 'receipt')).toBe(true);
    const { lanes } = await get<{ lanes: { id: string; state: string }[] }>('/lanes');
    expect(lanes.find((l) => l.id === 'BBZ-118')?.state).toBe('running');
  });

  it('reconnects an integration and unblocks its dependents', async () => {
    const before = await get<{ lanes: { id: string; state: string }[] }>('/lanes');
    expect(before.lanes.find((l) => l.id === 'FLT-211')?.state).toBe('blocked');
    await post('/integrations/aws/reconnect');
    const after = await get<{ lanes: { id: string; state: string }[] }>('/lanes');
    expect(after.lanes.find((l) => l.id === 'FLT-211')?.state).toBe('running');
  });

  // H2.3
  it('previews and then performs a bulk retire of finished lanes', async () => {
    const preview = await get<{ items: { id: string }[] }>('/retire-finished');
    expect(preview.items.map((i) => i.id).sort()).toEqual(['FLT-190', 'FLT-193']);
    const { body } = await post<{ ok: boolean; retired: string[] }>('/retire-finished');
    expect(body.retired.sort()).toEqual(['FLT-190', 'FLT-193']);
    const archived = await get<{ lanes: { id: string }[] }>('/lanes?archived=1');
    expect(archived.lanes.map((l) => l.id).sort()).toEqual(['FLT-190', 'FLT-193']);
  });

  it('a retired lane comes back on unretire', async () => {
    await post('/retire-finished');
    const jid = (await post<{ jid: string }>('/run/FLT-193/unretire')).body.jid;
    expect(jid).toBeTruthy();
    const archived = await get<{ lanes: { id: string }[] }>('/lanes?archived=1');
    expect(archived.lanes.map((l) => l.id)).not.toContain('FLT-193');
  });

  it('previews and then performs a bulk merge of ready lanes, in the real server shape', async () => {
    const preview = await get<{ ready: { id: string }[]; notReady: { id: string }[] }>('/merge-ready');
    expect(preview.ready.map((r) => r.id)).toEqual(['FLT-193']);
    expect(preview.notReady).toEqual([]);
    // Matches the real POST /merge-ready shape (src/forge/server.ts mergeReadyPost):
    // {ok, outcomes: [{id, ok, message}]} -- never the older {merged, failed} shape.
    const { body } = await post<{ ok: boolean; outcomes: { id: string; ok: boolean; message: string }[] }>('/merge-ready');
    expect(body.outcomes).toEqual([{ id: 'FLT-193', ok: true, message: expect.any(String) }]);
    const { lanes } = await get<{ lanes: { id: string; state: string }[] }>('/lanes');
    expect(lanes.find((l) => l.id === 'FLT-193')?.state).toBe('merged');
  });

  it('serves a story for a lane with a ticket, brief, PR and a merge', async () => {
    const story = await get<{ entries: { kind: string }[]; ticket: { key: string } | null }>('/run/FLT-190/story');
    expect(story.ticket?.key).toBe('FLT-190');
    expect(story.entries.some((e) => e.kind === 'pr')).toBe(true);
    expect(story.entries.some((e) => e.kind === 'merge')).toBe(true);
  });

  // H2.7
  it('serves the human-board fixture: 31 lanes, 4 probes, a three-attempt chain ticket, all titled and plained', async () => {
    await post('/__test/fixture?name=human-board');
    const { lanes } = await get<{ lanes: { id: string; kind: string; ticket: string | null; attempt: number; title: string | null; plain: string }[] }>('/lanes');
    expect(lanes).toHaveLength(31);
    expect(lanes.filter((l) => l.kind === 'probe')).toHaveLength(4);
    const chain = lanes.filter((l) => l.ticket === 'FLT-700');
    expect(chain).toHaveLength(3);
    expect(chain.map((l) => l.attempt).sort()).toEqual([1, 2, 3]);
    expect(lanes.some((l) => l.kind === 'self')).toBe(true);
    expect(lanes.every((l) => l.title !== null && l.plain !== '')).toBe(true);
  });

  // Item 9: plain by default, raw rows under ?verbose=1, on the run-scoped thread.
  describe('run thread verbose parity', () => {
    const MACHINE_ID = /S-[0-9a-f]{12,}|jira_|queue-[A-Z]|[0-9a-f]{40}/;

    it('plain mode carries an activity message, a reply, an "Asked you:" event, and no machine ids', async () => {
      await post('/__test/fixture?name=human-board');
      const { messages, verbose } = await get<{ messages: { type: string; text: string }[]; verbose?: boolean }>('/run/parked-1/thread');
      expect(verbose).toBeFalsy();
      expect(messages.some((m) => m.type === 'activity')).toBe(true);
      expect(messages.some((m) => m.type === 'reply')).toBe(true);
      expect(messages.some((m) => m.type === 'event' && m.text.startsWith('Asked you:'))).toBe(true);
      for (const m of messages) expect(m.text).not.toMatch(MACHINE_ID);
    });

    it('verbose mode returns rows carrying the run id', async () => {
      const { messages, verbose } = await get<{ messages: { type: string; text: string }[]; verbose?: boolean }>('/run/BBZ-118/thread?verbose=1');
      expect(verbose).toBe(true);
      expect(messages.some((m) => /S-[0-9a-f]{12,}/.test(m.text))).toBe(true);
    });
  });

  // Sweep #6: the console reads success off a non-null jid (`receiptCard`'s
  // `type: jid ? 'receipt' : 'refusal'`); a dismiss with no jid rendered as a red
  // Refused card even though it succeeded.
  it('POST /clear returns a jid on a successful dismiss, and clears the lane\'s question', async () => {
    const cleared = await post<{ ok: boolean; jid: string | null }>('/clear', { inboxKey: 'ask-bbz-118' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.ok).toBe(true);
    expect(cleared.body.jid).toBeTruthy();
    const { lanes } = await get<{ lanes: { id: string; question: unknown }[] }>('/lanes');
    const lane = lanes.find((l) => l.id === 'BBZ-118');
    expect(lane?.question).toBeNull();
  });
});
