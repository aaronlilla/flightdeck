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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fetchConfirmed } from '../../helpers/confirmed.js';

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

/** The route is irreversible, so it answers 202 with a token first and writes nothing
 *  until the request comes back carrying it. `fetchConfirmed` does that second press,
 *  the way the console's own confirm card does. */
async function handoff(key: string, body: unknown, withToken = true): Promise<{ status: number; body: HandoffResult }> {
  const response = await fetchConfirmed(`${base}/ticket/${encodeURIComponent(key)}/handoff`, {
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

  // Irreversible: a comment cannot be unposted and a transition cannot be taken back
  // from here, so the first press must ask and write nothing.
  it('asks before it writes, and the asking press writes nothing', async () => {
    const response = await fetch(`${base}/ticket/BBZ-290/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': token },
      body: JSON.stringify({ to: 'qa', comment: 'over to you' }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ pending: true });
    expect(wrote).toEqual([]);
  });

  // Found by code review. The console throws on any non-2xx and hands the body to
  // `redactErrorBody`, which reads an `error` field and otherwise says "the server did
  // not say why". A refusal that carries its sentence only in `refused` therefore
  // reaches the operator as nothing at all -- which is the whole point of the route.
  it('puts the refusal sentence where the console can read it', async () => {
    const refusals = [
      await handoff('BBZ-290', { to: 'joe', comment: 'over to you' }),
      await handoff('BBZ-290', { to: 'qa', comment: '   ' }),
    ];
    deps.client = null;
    refusals.push(await handoff('BBZ-290', { to: 'qa', comment: 'over to you' }));

    for (const { body } of refusals) {
      const carried = (body as unknown as { error?: unknown }).error;
      expect(typeof carried, JSON.stringify(body)).toBe('string');
      expect(carried).toBe(body.refused);
    }
  });

  // Found by code review, and it writes before it refuses. `deps.people[to]` is a plain
  // lookup, so a `to` that resolves on Object.prototype walks past the unknown-destination
  // guard -- the comment posts to Jira, which cannot be taken back, and only then does it
  // report "no account id is configured for undefined".
  it('refuses a destination that only exists on the prototype, before writing anything', async () => {
    for (const to of ['constructor', '__proto__', 'toString', 'valueOf']) {
      wrote = [];
      const { status, body } = await handoff('BBZ-290', { to, comment: 'over to you' });

      expect(status, to).toBe(400);
      expect(body.refused, to).toMatch(/not somebody this console can hand to/);
      expect(wrote, `${to} must not post a comment first`).toEqual([]);
    }
  });

  /** Every `decision.made` row the journal holds, with what it recorded. */
  function decisions(): { action?: string; text?: string }[] {
    const raw = readFileSync(join(dir, 'fleet.jsonl'), 'utf8');
    return raw.split(/\r?\n/).filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { event: string; action?: string; text?: string })
      .filter((row) => row.event === 'decision.made');
  }

  // Found by design critique. Kill and merge both write a `decision.made` row plus its
  // ledger mirror; the worker's own Jira writes emit external.intent/call/complete. This
  // route wrote to Jira -- irreversibly, on somebody else's board -- and left nothing but
  // a chat card. A handoff that half-landed could not be reconstructed afterwards at all.
  it('records what it did where the journal can be read, not only in the thread', async () => {
    await handoff('BBZ-290', { to: 'qa', comment: 'over to you' });

    const rows = decisions();
    expect(rows.map((row) => row.action)).toContain('ticket-handoff');
    const row = rows.find((r) => r.action === 'ticket-handoff');
    expect(row?.text).toContain('BBZ-290');
    // The per-step outcome, not one verdict: a half-landed handoff has to be findable.
    expect(row?.text).toMatch(/comment|assign|transition/);
  });

  it('records a refusal too, so a handoff nobody made is not indistinguishable from one never asked for', async () => {
    await handoff('BBZ-290', { to: 'joe', comment: 'over to you' });

    const row = decisions().find((r) => r.action === 'ticket-handoff');
    expect(row?.text).toMatch(/not somebody this console can hand to/);
  });

  // The queue path runs voiceGuard before it posts, to keep agent self-narration and
  // Aaron in the third person off tickets Joe and Haiping read. This route took free
  // text from an operator and posted it with only the readability backstop.
  it('refuses a comment voiceGuard would refuse, before writing anything', async () => {
    const { status, body } = await handoff('BBZ-290', {
      to: 'qa', comment: 'Aaron reported this one; fixed in this session.',
    });

    expect(status).toBe(400);
    expect(body.refused).toMatch(/reads wrong for a ticket.*third person/i);
    expect(wrote).toEqual([]);
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
