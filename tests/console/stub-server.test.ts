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
  it('serves the 14-lane board with one lane per state', async () => {
    const { lanes } = await get<{ lanes: { state: string }[] }>('/lanes');
    expect(lanes.length).toBe(14);
    const states = new Set(lanes.map((l) => l.state));
    expect(states).toContain('running');
    expect(states).toContain('parked');
    expect(states).toContain('merged');
  });

  it('kills a run and journals it', async () => {
    const { status, body } = await post<{ ok: boolean; jid: string }>('/run/FLT-201/kill', { reason: 'operator' });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const { lanes } = await get<{ lanes: { id: string; state: string }[] }>('/lanes');
    expect(lanes.find((l) => l.id === 'FLT-201')?.state).toBe('killed');
  });

  it('refuses a per-run cap above the hard limit', async () => {
    const { status, body } = await post<{ error: string; hardUsd: number }>('/run/FLT-201/cap', { capUsd: 999 });
    expect(status).toBe(422);
    expect(body.hardUsd).toBe(100);
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
