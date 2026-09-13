/**
 * `POST /ticket/:key/handoff` through a real `ForgeServer`, the same way
 * `tests/forge/console/queue-route.test.ts` proves every other console route.
 *
 * The module underneath is proven on its own in
 * `a-ticket-can-be-handed-on-from-the-console.test.ts`. What this file is for is the
 * wiring: that the route exists at all (it did not, so a handoff meant leaving the
 * console for a terminal), that it is behind the same token as everything else, and that
 * the three situations a caller has to tell apart -- wrote nothing because the request
 * was wrong, wrote nothing because this machine has no credentials, wrote some of it --
 * do not all come back looking the same.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Inbox } from '../../../src/forge/inbox.js';
import { Journal } from '../../../src/forge/journal.js';
import { ForgeServer } from '../../../src/forge/server.js';
import { Lanes } from '../../../src/forge/supervisor.js';
import type { HandoffResult, TicketHandoffDeps } from '../../../src/forge/console/ticket-handoff.js';

let dir: string;
let server: ForgeServer;
let base: string;
let wrote: string[];
let deps: TicketHandoffDeps;
const token = 'the-token';

/** The writes a press actually made, in order, so a step that was skipped rather than
 *  attempted cannot hide behind a verdict. */
function fakeClient(over: Partial<Record<'comment' | 'assign' | 'transition', () => { ok: boolean; body?: string }>> = {}) {
  return {
    comment: async (key: string, body: string) => {
      wrote.push(`comment ${key} ${body}`);
      return over.comment?.() ?? { ok: true };
    },
    assign: async (key: string, accountId: string) => {
      wrote.push(`assign ${key} ${accountId}`);
      return over.assign?.() ?? { ok: true };
    },
    transition: async (key: string, transitionId: string) => {
      wrote.push(`transition ${key} ${transitionId}`);
      return over.transition?.() ?? { ok: true };
    },
  };
}

async function handoff(key: string, body: unknown, withToken = true): Promise<{ status: number; body: HandoffResult }> {
  const response = await fetch(`${base}/ticket/${encodeURIComponent(key)}/handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(withToken ? { 'x-forge-token': token } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as HandoffResult) : ({} as HandoffResult) };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'console-handoff-'));
  mkdirSync(join(dir, 'lanes'), { recursive: true });
  process.env['FORGE_HOME'] = dir;
  new Journal(join(dir, 'fleet.jsonl')).close();
  const modelPolicyPath = join(dir, 'model-policy.json');
  writeFileSync(modelPolicyPath, JSON.stringify({ version: 1, classes: {} }), 'utf8');
  wrote = [];
  deps = {
    client: fakeClient(),
    people: { qa: { name: 'QA', accountId: 'acct-qa', transitionId: '31' } },
  };
  server = new ForgeServer({
    lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')),
    journalPath: join(dir, 'fleet.jsonl'), port: 0, token, modelPolicyPath,
    handoffDeps: () => deps,
  });
  base = `http://127.0.0.1:${await server.listen()}`;
});

afterEach(async () => {
  await server.close();
});

describe('POST /ticket/:key/handoff', () => {
  it('makes all three writes and reports each one', async () => {
    const { status, body } = await handoff('BBZ-290', { to: 'qa', comment: 'over to you' });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(wrote).toEqual([
      'comment BBZ-290 over to you',
      'assign BBZ-290 acct-qa',
      'transition BBZ-290 31',
    ]);
    expect(body.steps.map((step) => step.name)).toEqual(['comment', 'assign', 'transition']);
  });

  // A caller that cannot tell "wrote none of it" from "wrote two of three" will report
  // the ticket handed on either way, which is the board lying in the one place a person
  // is relying on it.
  it('answers 200 with ok false when part of it landed, not a refusal', async () => {
    deps.client = fakeClient({ transition: () => ({ ok: false, body: 'transition 31 is not available' }) });

    const { status, body } = await handoff('BBZ-290', { to: 'qa', comment: 'over to you' });

    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.refused).toBe('');
    expect(body.steps.filter((step) => step.ok)).toHaveLength(2);
    expect(body.steps.find((step) => step.name === 'transition')?.detail).toMatch(/not available/);
  });

  it('refuses an unknown destination with 400 and writes nothing', async () => {
    const { status, body } = await handoff('BBZ-290', { to: 'joe', comment: 'over to you' });

    expect(status).toBe(400);
    expect(body.refused).toMatch(/joe/);
    expect(wrote).toEqual([]);
  });

  it('refuses an empty comment with 400 rather than posting a blank one', async () => {
    const { status, body } = await handoff('BBZ-290', { to: 'qa', comment: '   ' });

    expect(status).toBe(400);
    expect(body.refused).toMatch(/comment/i);
    expect(wrote).toEqual([]);
  });

  // Nothing configured is this machine's problem, not the caller's, and a caller retrying
  // a 400 forever because the console has no credentials is the wrong outcome.
  it('answers 503, not 400, when no credentials are wired', async () => {
    deps.client = null;

    const { status, body } = await handoff('BBZ-290', { to: 'qa', comment: 'over to you' });

    expect(status).toBe(503);
    expect(body.refused).toMatch(/jira/i);
  });

  it('is behind the same token as every other console write', async () => {
    const response = await fetch(`${base}/ticket/BBZ-290/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'qa', comment: 'over to you' }),
    });

    expect(response.status).toBe(401);
    expect(wrote).toEqual([]);
  });
});
