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

  it('previews and then performs a bulk merge of ready lanes', async () => {
    const preview = await get<{ ready: { id: string }[]; notReady: { id: string }[] }>('/merge-ready');
    expect(preview.ready.map((r) => r.id)).toEqual(['FLT-193']);
    expect(preview.notReady).toEqual([]);
    const { body } = await post<{ ok: boolean; merged: string[] }>('/merge-ready');
    expect(body.merged).toEqual(['FLT-193']);
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
});
