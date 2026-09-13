/**
 * `POST /run/:id/open-pr` through a real `ForgeServer`.
 *
 * The rules are proven on their own in
 * `a-pull-request-can-be-opened-from-the-console.test.ts`. This file is the wiring: that
 * the route exists, that it is behind the same token and the same confirm as every other
 * outward write, that a console with no GitHub wiring says so instead of pretending, and
 * that the three answers a caller must tell apart do not look alike.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchConfirmed } from '../../helpers/confirmed.js';
import { Inbox } from '../../../src/forge/inbox.js';
import { Journal } from '../../../src/forge/journal.js';
import { ForgeServer } from '../../../src/forge/server.js';
import { Lanes } from '../../../src/forge/supervisor.js';
import type { OpenPrDeps, OpenPrResult } from '../../../src/forge/console/open-pr.js';

let dir: string;
let server: ForgeServer;
let base: string;
let deps: OpenPrDeps | undefined;
let created: unknown[];
const token = 'the-token';

function wiring(over: Partial<OpenPrDeps> = {}): OpenPrDeps {
  return {
    lane: () => ({ repo: 'owner/repo', branch: 'feature/abc-1', base: 'develop', ticket: 'ABC-1' }),
    pushed: async () => true,
    existing: async () => null,
    create: vi.fn(async (input) => { created.push(input); return { ok: true as const, number: 9, url: 'https://github.com/x/y/pull/9' }; }),
    readability: () => ({ verdict: 'SILENT', reason: '' }),
    ...over,
  };
}

async function open(run: string, body: unknown, withToken = true): Promise<{ status: number; body: OpenPrResult & { error?: string } }> {
  const response = await fetchConfirmed(`${base}/run/${encodeURIComponent(run)}/open-pr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(withToken ? { 'x-forge-token': token } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'console-openpr-'));
  mkdirSync(join(dir, 'lanes'), { recursive: true });
  process.env['FORGE_HOME'] = dir;
  new Journal(join(dir, 'fleet.jsonl')).close();
  const modelPolicyPath = join(dir, 'model-policy.json');
  writeFileSync(modelPolicyPath, JSON.stringify({ version: 1, classes: {} }), 'utf8');
  created = [];
  deps = wiring();
  server = new ForgeServer({
    lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')),
    journalPath: join(dir, 'fleet.jsonl'), port: 0, token, modelPolicyPath,
    openPrDeps: () => deps as OpenPrDeps,
  });
  base = `http://127.0.0.1:${await server.listen()}`;
});

afterEach(async () => {
  await server.close();
});

describe('POST /run/:id/open-pr', () => {
  it('opens one and answers with its number and link', async () => {
    const { status, body } = await open('run-1', { title: 'ABC-1 fix the thing', body: 'What breaks\n\nIt did not.' });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.number).toBe(9);
    expect(created).toHaveLength(1);
  });

  it('passes the draft flag through rather than always opening a ready one', async () => {
    await open('run-1', { title: 'ABC-1 fix', body: 'What breaks\n\nIt did not.', draft: true });
    expect(created[0]).toMatchObject({ draft: true });
  });

  // Opening a request is outward-facing and, on the app repository, spends a build. The
  // first press has to say that, and open nothing.
  it('asks before it opens, and says a build is spent', async () => {
    const response = await fetch(`${base}/run/run-1/open-pr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': token },
      body: JSON.stringify({ title: 'ABC-1 fix', body: 'What breaks\n\nIt did not.' }),
    });

    expect(response.status).toBe(202);
    const pending = await response.json() as { pending: boolean; blast: string };
    expect(pending.pending).toBe(true);
    expect(pending.blast).toMatch(/spends a build/);
    expect(created).toEqual([]);
  });

  // Already-open is not a bad request: the caller asked something reasonable and the
  // world was not what it assumed. It also needs the existing request's link back.
  it('answers 409 with the existing link when one is already open', async () => {
    deps = wiring({ existing: async () => ({ number: 4, url: 'https://github.com/x/y/pull/4' }) });

    const { status, body } = await open('run-1', { title: 'ABC-1 fix', body: 'What breaks\n\nIt did not.' });

    expect(status).toBe(409);
    expect(body.url).toBe('https://github.com/x/y/pull/4');
    expect(body.error).toMatch(/already/i);
    expect(created).toEqual([]);
  });

  it('answers 400 for a request that was wrong, and opens nothing', async () => {
    deps = wiring({ pushed: async () => false });

    const { status, body } = await open('run-1', { title: 'ABC-1 fix', body: 'What breaks\n\nIt did not.' });

    expect(status).toBe(400);
    expect(body.error).toMatch(/push/i);
    expect(created).toEqual([]);
  });

  // The refusal has to reach the operator. A body carrying its sentence only in
  // `refused` reads as "the server did not say why" once the console throws on non-2xx.
  it('puts the refusal sentence where the console can read it', async () => {
    deps = wiring({ readability: () => ({ verdict: 'DENY', reason: 'no ticket key in the title' }) });

    const { body } = await open('run-1', { title: 'fix', body: 'What breaks\n\nIt did not.' });

    expect(body.error).toBe(body.refused);
    expect(body.error).toMatch(/no ticket key/);
  });

  it('says so plainly when this console has no GitHub wiring at all', async () => {
    deps = undefined;

    const { status, body } = await open('run-1', { title: 'ABC-1 fix', body: 'What breaks\n\nIt did not.' });

    expect(status).toBe(501);
    expect(body.error).toBe('not wired');
  });

  it('is behind the same token as every other console write', async () => {
    const response = await fetch(`${base}/run/run-1/open-pr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'ABC-1 fix', body: 'x' }),
    });

    expect(response.status).toBe(401);
    expect(created).toEqual([]);
  });
});
