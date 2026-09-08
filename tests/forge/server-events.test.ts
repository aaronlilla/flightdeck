/**
 * The live spine's contract: every console write publishes a slice-named event on
 * `/events` the moment it has been answered, so the board refetches that slice and
 * nothing else. The sample below is written by hand and on purpose does not read the
 * server's own route table (`MUTATING_ROUTES` in `src/shared/console-events.ts`): a
 * route dropped from that table must show up here as a missing frame, not vanish
 * from the walk along with its publish.
 *
 * Every write runs against a bare specimen server with a fake actuator, so nothing
 * here signals a real process, merges anything or reaches a network. Most calls are
 * refused (no such lane, no such item); a refusal still publishes, since the stale
 * board is what led to the refusal.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Actuator } from '../../src/forge/contracts.js';
import { Inbox } from '../../src/forge/inbox.js';
import { Journal } from '../../src/forge/journal.js';
import { Registry } from '../../src/forge/registry.js';
import { ForgeServer } from '../../src/forge/server.js';
import { Lanes } from '../../src/forge/supervisor.js';
import { isSliceEvent, type SliceName } from '../../src/shared/console-events.js';
import { scriptedQuery } from './console/agent-fake.js';

interface Sample {
  path: string;
  body?: Record<string, unknown>;
  /** At least one of these slices must be named by a frame the write produced. */
  slices: SliceName[];
}

/** One request per write the console can issue. `body` is the least a route needs to
 *  reach its own handler rather than a body-shape 400, though a 400 publishes too. */
const SAMPLES: Sample[] = [
  { path: '/answer', body: { key: 'ask-none', answer: 'yes' }, slices: ['lanes', 'conductor'] },
  { path: '/stop', body: { reason: 'specimen' }, slices: ['lanes'] },
  { path: '/send', body: { run: 'ghost', text: 'hello' }, slices: ['lanes'] },
  { path: '/amend', body: { run: 'ghost', text: 'hello' }, slices: ['lanes'] },
  { path: '/clear', body: { lane: 'ghost' }, slices: ['lanes'] },
  { path: '/router', body: { text: 'status' }, slices: ['conductor'] },
  { path: '/command', body: { text: 'status' }, slices: ['conductor'] },
  { path: '/run/ghost/recheck', slices: ['lanes'] },
  { path: '/run/ghost/retire', slices: ['lanes'] },
  { path: '/run/ghost/unretire', slices: ['lanes'] },
  { path: '/run/ghost/kill', body: { reason: 'specimen' }, slices: ['lanes'] },
  { path: '/run/ghost/pause', slices: ['lanes'] },
  { path: '/run/ghost/resume', slices: ['lanes'] },
  { path: '/run/ghost/merge', slices: ['lanes'] },
  { path: '/run/ghost/reopen', slices: ['lanes'] },
  { path: '/run/ghost/compact', slices: ['lanes'] },
  { path: '/run/ghost/verify', slices: ['lanes'] },
  { path: '/run/ghost/cap', body: { tokenCap: 1000 }, slices: ['lanes', 'caps'] },
  { path: '/run/ghost/reaudit', slices: ['lanes'] },
  { path: '/retire-finished', slices: ['lanes'] },
  { path: '/merge-ready', slices: ['lanes'] },
  { path: '/caps', body: { dailyTokens: 1000 }, slices: ['caps'] },
  { path: '/integrations/ghost/check', slices: ['integrations'] },
  { path: '/integrations/ghost/reconnect', slices: ['integrations'] },
  { path: '/proposals/ghost/apply', slices: ['proposals'] },
  { path: '/proposals/ghost/dismiss', slices: ['proposals'] },
  { path: '/proposals/ghost/restore', slices: ['proposals'] },
  { path: '/journal/ghost/undo', slices: ['journal'] },
  { path: '/queue', body: { source: 'brief', input: 'a brief' }, slices: ['queue'] },
  { path: '/queue/pause', slices: ['queue'] },
  { path: '/queue/resume', slices: ['queue'] },
  { path: '/queue/ghost/remove', slices: ['queue'] },
  { path: '/queue/ghost/retry', slices: ['queue'] },
  { path: '/queue/ghost/merge', slices: ['queue'] },
  { path: '/queue/ghost/promote', body: { version: '1.0.0', message: 'm' }, slices: ['queue'] },
  { path: '/blockers/ghost/resolve', slices: ['blockers'] },
  { path: '/blockers/ghost/check', slices: ['blockers'] },
];

const idleActuator: Actuator = {
  kill: async () => ({ ok: false, message: 'specimen never kills' }),
  pause: async () => ({ ok: false, message: 'specimen never pauses' }),
  resume: async () => ({ ok: false, message: 'specimen never resumes' }),
} as unknown as Actuator;

let dir: string;
let server: ForgeServer;
let base: string;
let published: Record<string, unknown>[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'forge-server-events-'));
  process.env['FORGE_HOME'] = dir;
  const journal = new Journal(join(dir, 'fleet.jsonl'));
  journal.close();
  // `implement` is the class the Conductor reasons on (`CONDUCTOR_CLASS`), and a class
  // nobody declared throws rather than guessing, so `/command` needs it here. The
  // aliases come with it: the model name resolves through them.
  writeFileSync(join(dir, 'model-policy.json'), JSON.stringify({
    classes: { implement: { model: 'sonnet', effort: 'medium', maxContext: 150_000, maxTurns: 120, provider: 'claude' } },
    aliases: { sonnet: 'claude-sonnet-5' },
    governor: { dailyTokens: 5_000_000, runTokens: 1_000_000 },
  }));
  server = new ForgeServer({
    lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')),
    journalPath: join(dir, 'fleet.jsonl'), registry: new Registry(join(dir, 'registry')),
    consoleActuator: idleActuator, modelPolicyPath: join(dir, 'model-policy.json'),
    // `/command` routes to the Conductor agent by default. The agent path is the one
    // this walk has to exercise, so it gets a scripted model rather than being turned
    // off: disabled, the route would fall back to the grammar and this sample would
    // stop covering the handler the console actually reaches.
    conductorQueryFn: scriptedQuery([{ tools: [], reply: 'nothing is stuck.' }]).fn,
    forgeHomeDir: dir, port: 0,
  });
  published = [];
  vi.spyOn(server, 'publish').mockImplementation((event) => { published.push(event); });
  base = `http://127.0.0.1:${await server.listen()}`;
});

afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
});

async function post(path: string, body: Record<string, unknown> | undefined): Promise<{ status: number; text: string }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'x-forge-token': server.token, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, text: await response.text() };
}

/** The response's `finish` fires after the body is on the wire, so the publish can
 *  land a tick after `fetch` resolves. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('every console write publishes a slice event', () => {
  it.each(SAMPLES.map((sample) => [sample.path, sample] as const))('%s', async (_path, sample) => {
    const before = published.length;
    const { status, text } = await post(sample.path, sample.body);
    await settle();
    const slices = published.slice(before).filter(isSliceEvent);
    // A route's own 404 (no such lane, no such item) is a handled write and publishes;
    // the server's catch-all 404 means the sample names a path nothing serves.
    expect(text, `${sample.path} reached no route`).not.toMatch(/nothing serves/);
    const named = slices.map((event) => event.slice);
    expect(named, `${sample.path} answered ${status} and published ${JSON.stringify(published.slice(before))}`)
      .toEqual(expect.arrayContaining(sample.slices));
    for (const event of slices) {
      expect(event.reason).toMatch(/answered \d{3}$/);
      expect(typeof event.at).toBe('number');
    }
  });

  it('a read publishes nothing', async () => {
    const before = published.length;
    const response = await fetch(`${base}/lanes`, { headers: { 'x-forge-token': server.token } });
    await response.text();
    await settle();
    expect(published.slice(before).filter(isSliceEvent)).toEqual([]);
  });

  it('names the lane a run action was about', async () => {
    const before = published.length;
    await post('/run/some-lane/pause', undefined);
    await settle();
    const event = published.slice(before).filter(isSliceEvent)[0];
    expect(event?.ref).toBe('some-lane');
  });
});

describe('the fleet journal growing publishes lanes and journal', () => {
  it('a row another process appends reaches the socket within the watch interval', async () => {
    const before = published.length;
    const journal = new Journal(join(dir, 'fleet.jsonl'));
    journal.append({ event: 'run.started', run: 'from-a-ticker', actor: 'runner' });
    journal.close();
    await vi.waitFor(() => {
      const named = published.slice(before).filter(isSliceEvent).map((event) => event.slice);
      expect(named).toEqual(expect.arrayContaining(['lanes', 'journal']));
    }, { timeout: 3000, interval: 50 });
  });
});
