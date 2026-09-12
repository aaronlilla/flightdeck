/**
 * Item 4 of the pipeline-hardening brief (2026-09-11): confirm tokens die with the
 * console process.
 *
 * `command.ts` holds pending confirms in an in-memory Map and persists only the kill and
 * retire descriptors. A merge proposed before a restart -- and the console restarts on
 * its own cadence, seven times on 2026-09-11 -- came back `nothing pending for <uuid>`
 * when Aaron finally clicked it, silently voiding the click.
 *
 * The restart here is the real one the other confirm specimens use: close the server and
 * start a new one over the same forge home, which is exactly what `cli.ts` exiting 75 and
 * the supervisor restarting does.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Inbox } from '../../src/forge/inbox.js';
import { Journal } from '../../src/forge/journal.js';
import { Registry } from '../../src/forge/registry.js';
import { Lanes } from '../../src/forge/supervisor.js';
import { ForgeServer } from '../../src/forge/server.js';

const LANE = '2026-09-11-acme-merge-wait';

let dir: string;
let server: ForgeServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-merge-confirm-'));
  process.env['FORGE_HOME'] = dir;
  const journal = new Journal(join(dir, 'fleet.jsonl'));
  journal.append({ event: 'run.started', run: LANE, actor: 'runner' });
  journal.append({ event: 'run.finished', run: LANE, verdict: 'done' });
  journal.close();
  new Lanes(join(dir, 'lanes')).put(LANE, { column: 'c', model: 'claude-sonnet-5', context: 1000, cost_usd: 0, session_id: 's1' });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(): Promise<string> {
  server = new ForgeServer({
    lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')), journalPath: join(dir, 'fleet.jsonl'),
    registry: new Registry(join(dir, 'registry')), port: 0,
  });
  return `http://127.0.0.1:${await server.listen()}`;
}

async function restart(): Promise<string> {
  await server!.close();
  server = undefined;
  return start();
}

async function postMerge(base: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/run/${LANE}/merge`, {
    method: 'POST', headers: { 'x-forge-token': server!.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('item 4: a merge confirm survives the console restarting under it', () => {
  it('honours a merge token minted before the restart', async () => {
    const base = await start();
    const proposed = await postMerge(base, {});
    expect(proposed.status).toBe(202);
    const token = String(proposed.body['token']);

    const fresh = await restart();
    const after = await postMerge(fresh, { confirm: token });

    expect(String(after.body['error'] ?? '')).not.toMatch(/nothing pending/);
  });

  it('refuses an expired token with a reason naming the expiry, never a bare nothing pending', async () => {
    const base = await start();
    const proposed = await postMerge(base, {});
    const token = String(proposed.body['token']);

    // Age the persisted row past its two-hour life, the one thing a test cannot wait for.
    const path = join(dir, 'pending-confirms.json');
    const rows = JSON.parse(readFileSync(path, 'utf8')) as Array<{ token: string; at: number }>;
    for (const row of rows) if (row.token === token) row.at = Date.now() - 3 * 60 * 60_000;
    writeFileSync(path, JSON.stringify(rows), 'utf8');

    // Across a restart, so the in-memory entry is gone and the persisted row is the only
    // thing left to read -- the shape the operator actually meets.
    const fresh = await restart();
    const after = await postMerge(fresh, { confirm: token });

    expect(after.status).toBe(409);
    expect(String(after.body['error'])).toMatch(/expired/i);
    expect(String(after.body['error'])).not.toMatch(/^nothing pending/);
  });

  it('gives the typed confirm the same expiry sentence the clicked one gets', async () => {
    const base = await start();
    const proposed = await postMerge(base, {});
    const token = String(proposed.body['token']);

    const path = join(dir, 'pending-confirms.json');
    const rows = JSON.parse(readFileSync(path, 'utf8')) as Array<{ token: string; at: number }>;
    for (const row of rows) if (row.token === token) row.at = Date.now() - 3 * 60 * 60_000;
    writeFileSync(path, JSON.stringify(rows), 'utf8');

    const fresh = await restart();
    const response = await fetch(`${fresh}/command`, {
      method: 'POST', headers: { 'x-forge-token': server!.token, 'content-type': 'application/json' },
      body: JSON.stringify({ text: `confirm ${token}` }),
    });
    const { cards } = (await response.json()) as { cards: Array<{ type: string; text: string }> };
    const refusal = cards.find((card) => card.type === 'refusal');

    expect(refusal?.text).toMatch(/expired/i);
  });

  it('still names the expiry after another confirm has rewritten the store', async () => {
    // The store is rewritten whole on every put, and the prune drops aged rows, so an
    // expired token stopped being nameable the moment anything else was proposed. The
    // earlier specimen passed only because nothing happened in between.
    const base = await start();
    const proposed = await postMerge(base, {});
    const token = String(proposed.body['token']);

    const path = join(dir, 'pending-confirms.json');
    const rows = JSON.parse(readFileSync(path, 'utf8')) as Array<{ token: string; at: number }>;
    for (const row of rows) if (row.token === token) row.at = Date.now() - 3 * 60 * 60_000;
    writeFileSync(path, JSON.stringify(rows), 'utf8');

    const fresh = await restart();
    await postMerge(fresh, {});          // a second proposal rewrites the store
    const after = await postMerge(fresh, { confirm: token });

    expect(String(after.body['error'])).toMatch(/expired/i);
  });

  it('still refuses a token nobody ever minted, with the unchanged sentence', async () => {
    const base = await start();
    const after = await postMerge(base, { confirm: '00000000-0000-4000-8000-000000000000' });

    expect(after.status).toBe(409);
    expect(String(after.body['error'])).toMatch(/nothing pending/);
  });

  it('cannot spend the same merge token twice across a restart', async () => {
    const base = await start();
    const proposed = await postMerge(base, {});
    const token = String(proposed.body['token']);
    await postMerge(base, { confirm: token });

    const fresh = await restart();
    const again = await postMerge(fresh, { confirm: token });

    expect(again.status).toBe(409);
  });
});
