/**
 * R-81, the wiring half: the timer `forge up` schedules is the runner's own `tick`, and
 * the state read carries what that runner knows.
 *
 * The first test is a source-shape check on purpose. The falsifier in the goal brief is a
 * test that passes against a wrapper the real timer never calls, and no amount of unit
 * testing the runner can rule that out -- only reading what `cli.ts` actually hands to
 * `setInterval` can. `tests/checks/` already uses this idiom for the same reason.
 *
 * The second runs a real `ForgeServer` on an ephemeral port and reads `/state` over HTTP,
 * asserting the status code before the body: a read that returns an error body is not an
 * empty result.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Inbox } from '../../src/forge/inbox.js';
import { replayEvents } from '../../src/forge/contracts.js';
import { Journal } from '../../src/forge/journal.js';
import { QueueStore } from '../../src/forge/intake/queueStore.js';
import { QueueTickBackoff } from '../../src/forge/queue-backoff.js';
import { notTickingHere, QueueTickRunner } from '../../src/forge/intake/queueTickRunner.js';
import { ForgeServer } from '../../src/forge/server.js';
import { Lanes } from '../../src/forge/supervisor.js';

describe('the queue timer schedules the runner itself', () => {
  const source = readFileSync(join(process.cwd(), 'src/forge/cli.ts'), 'utf8');

  it('hands setInterval the runner tick, not a closure of its own', () => {
    expect(source).toContain('setInterval(queueRunner.tick, pollSeconds * 1000)');
  });

  it('leaves no second call site running the tick outside the runner', () => {
    // `runQueueTick` may appear exactly twice in `cli.ts`: the import, and the one line
    // the runner is constructed with. A third is a path the runner does not guard.
    const mentions = source.match(/runQueueTick/g) ?? [];
    expect(mentions).toHaveLength(2);
    expect(source).toContain('tick: (items) => runQueueTick(queueDeps, items)');
  });

  it('publishes the runner status on the server it just built', () => {
    expect(source).toContain('server.queueLoop = () => queueRunner.status()');
  });

  it('says so on the state read when another process holds the queue lock', () => {
    // `/critique`, 2026-09-11: a null field on a process that never ticks reads exactly
    // like a loop that should be ticking and has stopped.
    expect(source).toContain('server.queueLoop = () => notTickingHere(');
  });
});

describe('GET /state carries the queue loop', () => {
  let home: string;
  let server: ForgeServer | undefined;
  let port = 0;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'forge-queue-loop-'));
    process.env['FORGE_HOME'] = home;
    mkdirSync(join(home, 'lanes'), { recursive: true });
    new Journal(join(home, 'fleet.jsonl')).close();
    const modelPolicyPath = join(home, 'model-policy.json');
    writeFileSync(modelPolicyPath, JSON.stringify({ version: 1, classes: {} }), 'utf8');
    server = new ForgeServer({
      lanes: new Lanes(join(home, 'lanes')), inbox: new Inbox(join(home, 'inbox')),
      journalPath: join(home, 'fleet.jsonl'), port: 0, modelPolicyPath,
      queueStore: new QueueStore(join(home, 'queue.jsonl')),
    });
    port = await server.listen();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  async function readState(): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`http://127.0.0.1:${port}/state`);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  it('serves null while no process in this server is ticking the queue', async () => {
    const { status, body } = await readState();
    expect(status).toBe(200);
    expect(body['queue_loop']).toBeNull();
  });

  it('serves the overdue sentence once a runner is wired to it', async () => {
    let at = 0;
    const journal = { append: (): void => {} };
    const runner = new QueueTickRunner<string>({
      tick: () => new Promise<void>(() => {}),
      items: () => [],
      journal,
      backoff: new QueueTickBackoff(journal, { now: () => at }),
      intervalMs: 15_000,
      now: () => at,
    });
    server!.queueLoop = () => runner.status();

    runner.tick();
    at = 15_000 * 4;

    const { status, body } = await readState();
    expect(status).toBe(200);
    const loop = body['queue_loop'] as Record<string, unknown>;
    expect(loop['overdue']).toBe(true);
    expect(loop['sentence']).toContain('1 minute');
    expect(loop['intervalSeconds']).toBe(15);
    expect(loop['ticking']).toBe(true);
  });

  it('serves a process that is not the ticker as not ticking, never as overdue', async () => {
    server!.queueLoop = () => notTickingHere(15_000);

    const { status, body } = await readState();
    expect(status).toBe(200);
    const loop = body['queue_loop'] as Record<string, unknown>;
    expect(loop['ticking']).toBe(false);
    expect(loop['overdue']).toBe(false);
    expect(loop['sentence']).toBe('This process is not running the queue loop; another process holds the queue lock.');
  });
});

describe('the rows survive a real journal on disk', () => {
  /** Both reviews on 2026-09-11 closed with the same "not verified": nothing had been run
   *  against a real `Journal` and a real replay. A fake journal that collects objects
   *  cannot show that `queue.tick-complete` is accepted by the closed event union -- and
   *  an unregistered name is quarantined on replay, and counted as a torn tail whenever
   *  it is the last line, which on a quiet fleet it usually is. */
  it('writes a completion row a real replay reads back, not quarantines', async () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-queue-journal-'));
    const path = join(home, 'fleet.jsonl');
    const journal = new Journal(path);
    let at = 1_700_000_000_000;
    const runner = new QueueTickRunner<string>({
      tick: async () => {},
      items: () => ['one'],
      journal: { append: (row) => journal.append(row as never) },
      backoff: new QueueTickBackoff({ append: (row) => journal.append(row as never) }, { now: () => at }),
      intervalMs: 15_000,
      now: () => at,
    });

    runner.tick();
    await runner.whenIdle();
    journal.close();

    const replayed = replayEvents(readFileSync(path, 'utf8'));
    expect(replayed.quarantined).toBe(0);
    expect(replayed.tornTail).toBe(false);
    expect(replayed.events.map((row) => row.event)).toContain('queue.tick-complete');
  });

  it('writes a failure row a real replay reads back too', async () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-queue-journal-fail-'));
    const path = join(home, 'fleet.jsonl');
    const journal = new Journal(path);
    let at = 1_700_000_000_000;
    const runner = new QueueTickRunner<string>({
      tick: async () => { throw new Error('cannot reach Jira'); },
      items: () => [],
      journal: { append: (row) => journal.append(row as never) },
      backoff: new QueueTickBackoff({ append: (row) => journal.append(row as never) }, { now: () => at }),
      intervalMs: 15_000,
      now: () => at,
    });

    runner.tick();
    await runner.whenIdle();
    journal.close();

    const replayed = replayEvents(readFileSync(path, 'utf8'));
    expect(replayed.quarantined).toBe(0);
    expect(replayed.tornTail).toBe(false);
    expect(replayed.events.map((row) => row.event)).toContain('queue.tick-error');
  });
});
