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
});
