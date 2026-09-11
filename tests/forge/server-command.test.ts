/**
 * `POST /command` routes to the Conductor agent by default (2026-09-08). Three things
 * this file holds: the shipped policy file, read through the real policy module with no
 * override, sends a typed message to the agent; an explicit `conductor.agent.enabled:
 * false` keeps it on the grammar; and a card's own `confirm <token>` is answered by the
 * grammar before the agent ever sees it.
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
import { conductorAgentEnabled, loadPolicy, policyPath } from '../../src/forge/policy.js';
import type { Message } from '../../src/shared/console-model.js';
import { scriptedQuery } from './console/agent-fake.js';

const DEAD = '2026-09-04-acme-c2-rn';

let dir: string;
let server: ForgeServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-server-command-'));
  process.env['FORGE_HOME'] = dir;
  delete process.env['FORGE_POLICY_PATH'];
  const journal = new Journal(join(dir, 'fleet.jsonl'));
  journal.append({ event: 'run.started', run: DEAD, actor: 'runner' });
  journal.append({ event: 'run.finished', run: DEAD, verdict: 'unverified' });
  journal.close();
  new Lanes(join(dir, 'lanes')).put(DEAD, { column: 'c', model: 'claude-sonnet-5', context: 1000, cost_usd: 0, session_id: 's1' });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(fake: ReturnType<typeof scriptedQuery>, modelPolicyPath?: string): Promise<string> {
  server = new ForgeServer({
    lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')), journalPath: join(dir, 'fleet.jsonl'),
    registry: new Registry(join(dir, 'registry')), port: 0, conductorQueryFn: fake.fn,
    ...(modelPolicyPath ? { modelPolicyPath } : {}),
  });
  return `http://127.0.0.1:${await server.listen()}`;
}

async function command(base: string, text: string, run?: string): Promise<Message[]> {
  const response = await fetch(`${base}/command`, {
    method: 'POST', headers: { 'x-forge-token': server!.token, 'content-type': 'application/json' },
    body: JSON.stringify({ text, ...(run ? { run } : {}) }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { cards: Message[] }).cards;
}

describe('POST /command and the Conductor agent', () => {
  it('with no policy override at all, the shipped model-policy.json routes a typed message to the agent', async () => {
    // The real policy module, the tracked file, no fixture: this is the default that ships.
    expect(policyPath()).toMatch(/model-policy\.json$/);
    expect(loadPolicy().conductor?.agent?.enabled).toBe(true);
    expect(conductorAgentEnabled()).toBe(true);

    const fake = scriptedQuery([{ tools: [{ tool: 'retire', input: { lane: DEAD } }], reply: 'Proposed; the card is waiting.' }]);
    const base = await start(fake);
    const cards = await command(base, `remove ${DEAD}`);

    expect(fake.prompts).toHaveLength(1);
    expect(cards.map((card) => card.type)).toEqual(['operator', 'reply', 'confirm']);
    expect(cards[1]!.path).toBe('agent');
    expect(cards[1]!.text).toBe('Proposed; the card is waiting.');
  });

  it('with conductor.agent.enabled: false the grammar answers and the fake never runs', async () => {
    const policy = JSON.parse(readFileSync(policyPath(), 'utf8')) as Record<string, unknown>;
    policy['conductor'] = { agent: { enabled: false } };
    const override = join(dir, 'policy-off.json');
    writeFileSync(override, JSON.stringify(policy), 'utf8');

    const fake = scriptedQuery([{ reply: 'never' }]);
    const base = await start(fake, override);
    const cards = await command(base, `remove ${DEAD}`);

    expect(fake.calls).toHaveLength(0);
    expect(cards.map((card) => card.type)).toEqual(['operator', 'confirm']);
    expect(cards[1]!.path).toBe('grammar');
  });

  it('confirm <token> never reaches the model: the grammar runs the pending action and the fake sees one prompt only', async () => {
    const fake = scriptedQuery([{ tools: [{ tool: 'retire', input: { lane: DEAD } }], reply: 'Proposed.' }]);
    const base = await start(fake);
    const proposed = await command(base, `remove ${DEAD}`);
    const card = proposed.find((row) => row.type === 'confirm')!;
    const token = card.btns!.find((btn) => btn.cmd.startsWith('confirm '))!.cmd.split(' ')[1]!;

    const after = await command(base, `confirm ${token}`);
    expect(after.map((row) => row.type)).toEqual(['operator', 'receipt']);
    expect(after[1]!.text).toBe(`retired ${DEAD}`);
    expect(fake.prompts).toHaveLength(1);
    expect(fake.toolCalls).toHaveLength(1);

    const dismissed = await command(base, `dismiss ${token}`);
    expect(dismissed[1]!.type).toBe('refusal');
    expect(fake.prompts).toHaveLength(1);
  });

  it('a message typed into a sheet carries the lane, and the reply lands in that run\'s own thread', async () => {
    const fake = scriptedQuery([{ tools: [{ tool: 'kill', input: { lane: DEAD, andRetire: true } }], reply: 'Kill and remove proposed.' }]);
    const base = await start(fake);
    await command(base, 'kill and remove this', DEAD);
    expect(fake.prompts[0]).toContain(`operator has this lane's sheet open: ${DEAD}`);

    const thread = await fetch(`${base}/run/${DEAD}/thread`, { headers: { 'x-forge-token': server!.token } });
    const { messages } = (await thread.json()) as { messages: Message[] };
    expect(messages.map((row) => [row.type, row.source])).toEqual(expect.arrayContaining([
      ['receipt', 'conductor'], ['reply', 'conductor'],
    ]));
    expect(messages.find((row) => row.type === 'reply')?.text).toBe('Kill and remove proposed.');
  });
});

/**
 * The console restarts on its own cadence: `cli.ts` exits 75 and the supervisor starts a
 * NEW process (`AppExit 75 Restart`), which replays the journal from scratch. A confirm
 * card the operator has not clicked yet must survive that boundary -- before this, every
 * pending token died with the process and the click came back
 * `refused: nothing pending for <uuid>`.
 */
describe('a confirm survives the console restarting under it', () => {
  async function restart(): Promise<string> {
    await server!.close();
    server = undefined;
    return start(scriptedQuery([]));
  }

  it('a token minted before the restart still runs after it', async () => {
    const base = await start(scriptedQuery([]));
    const proposed = await command(base, `remove ${DEAD}`);
    const card = proposed.find((row) => row.type === 'confirm')!;
    const token = card.btns!.find((btn) => btn.cmd.startsWith('confirm '))!.cmd.split(' ')[1]!;

    const fresh = await restart();
    const after = await command(fresh, `confirm ${token}`);
    expect(after.map((row) => row.type)).toEqual(['operator', 'receipt']);
    expect(after[1]!.text).toBe(`retired ${DEAD}`);
  });

  it('still refuses a token nobody ever minted', async () => {
    const base = await start(scriptedQuery([]));
    await command(base, `remove ${DEAD}`);
    const fresh = await restart();
    const after = await command(fresh, 'confirm 00000000-0000-4000-8000-000000000000');
    expect(after[1]!.type).toBe('refusal');
  });

  it('a token spent before the restart cannot be spent again after it', async () => {
    const base = await start(scriptedQuery([]));
    const proposed = await command(base, `remove ${DEAD}`);
    const token = proposed.find((row) => row.type === 'confirm')!
      .btns!.find((btn) => btn.cmd.startsWith('confirm '))!.cmd.split(' ')[1]!;
    await command(base, `confirm ${token}`);

    const fresh = await restart();
    const again = await command(fresh, `confirm ${token}`);
    expect(again[1]!.type).toBe('refusal');
  });
});

/**
 * A confirm rebuilt after a restart must report the action's REAL outcome. The rebuilt
 * path has no entry in the in-memory map, so an `outcome ?? 200` fallback answered
 * `{ok: true}` for a kill the fleet had already refused.
 */
describe('a rebuilt confirm reports what the action actually did', () => {
  const GONE = '2026-09-04-no-such-run';

  it('answers the refusal, not a 200, when the rebuilt kill is refused', async () => {
    const base = await start(scriptedQuery([]));
    const propose = await fetch(`${base}/run/${GONE}/kill`, {
      method: 'POST', headers: { 'x-forge-token': server!.token, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(propose.status).toBe(202);
    const { token } = (await propose.json()) as { token: string };

    await server!.close();
    server = undefined;
    const fresh = await start(scriptedQuery([]));

    // No such run, so the kill underneath this confirm is refused by the fleet.
    const confirmed = await fetch(`${fresh}/run/${GONE}/kill`, {
      method: 'POST', headers: { 'x-forge-token': server!.token, 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: token }),
    });
    expect(confirmed.status).not.toBe(200);
  });
});

/**
 * "Kill and remove" is one instruction. Across a restart, the run ending on its own in
 * between is the normal case, not a rare one -- and a lane that already ended cannot be
 * killed (`killed` is not a kill-allowed state) while it CAN be removed. Skipping the
 * remove there leaves the row on the board, the opposite of what was confirmed.
 */
describe('a rebuilt kill-and-remove still removes when the run ended on its own', () => {
  it('removes the lane even though the kill half is refused', async () => {
    const fake = scriptedQuery([{ tools: [{ tool: 'kill', input: { lane: DEAD, andRetire: true } }], reply: 'Kill and remove proposed.' }]);
    const base = await start(fake);
    const proposed = await command(base, 'kill and remove it', DEAD);
    const token = proposed.find((row) => row.type === 'confirm')!
      .btns!.find((btn) => btn.cmd.startsWith('confirm '))!.cmd.split(' ')[1]!;

    await server!.close();
    server = undefined;
    // The run ends on its own while the card sits unclicked: now unkillable, still removeable.
    const journal = new Journal(join(dir, 'fleet.jsonl'));
    journal.append({ event: 'run.finished', run: DEAD, verdict: 'killed' });
    journal.close();
    const fresh = await start(scriptedQuery([]));

    const after = await command(fresh, `confirm ${token}`);
    expect(JSON.stringify(after)).toContain(`retired ${DEAD}`);
  });
});
