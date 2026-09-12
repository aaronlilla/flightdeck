import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readChainEnv } from '../../src/forge/chain-env.js';
import { QueueStore } from '../../src/forge/intake/queueStore.js';
import { buildSelfLoop, readAttestationRounds, transcriptsFromJournal } from '../../src/forge/self-wire.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-selfwire-'));
  dirs.push(dir);
  process.env['FORGE_HOME'] = dir;
  return dir;
}

describe('readAttestationRounds', () => {
  it('walks the attestation tree and keeps each round\'s missing members', () => {
    const h = home();
    const dir = join(h, 'attestations', 'owner', 'name', '12');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'abc.json'), JSON.stringify({ repo: 'owner/name', pr: 12, round: 2, coverage: { total: 4, missing: ['codex'] } }));
    writeFileSync(join(dir, 'bad.json'), 'nope');
    expect(readAttestationRounds(h)).toEqual([{ repo: 'owner/name', pr: 12, round: 2, missing: ['codex'] }]);
  });
});

describe('transcriptsFromJournal', () => {
  it('groups tool names, gotchas and park reasons per run', () => {
    const rows = [
      { event: 'tool.start', run: 'r1', tool: 'Bash' },
      { event: 'tool.start', run: 'r1', tool: 'Edit' },
      { event: 'gotcha.recorded', run: 'r1', gotchaId: 'g1' },
      { event: 'run.parked', run: 'r1', reason: 'branch already checked out' },
      { event: 'tool.start', run: 'r2', tool: 'Read' },
    ];
    expect(transcriptsFromJournal(rows)).toEqual([
      { run: 'r1', toolSequence: ['Bash', 'Edit'], gotchaIds: ['g1'], parkReasons: ['branch already checked out'] },
      { run: 'r2', toolSequence: ['Read'], gotchaIds: [], parkReasons: [] },
    ]);
  });
});

describe('buildSelfLoop', () => {
  it('is off with no self repo: a tick records nothing and asks for no restart', async () => {
    const h = home();
    const loop = buildSelfLoop({
      chainEnv: readChainEnv({} as NodeJS.ProcessEnv), store: new QueueStore(join(h, 'q.jsonl')),
      mergeDeps: {} as never, runningHead: 'abc', env: {} as NodeJS.ProcessEnv, home: h,
    });
    expect(loop.enabled).toBe(false);
    expect(await loop.tick()).toMatchObject({ enabled: false, enqueued: 0, restart: false });
    expect(loop.status()).toBeUndefined();
  });

  it('asks for a restart only when trunk moved and nothing is in flight', async () => {
    const h = home();
    const store = new QueueStore(join(h, 'q.jsonl'));
    const pulled: string[] = [];
    const git = {
      fetch: async () => {},
      remoteHead: async () => 'def456',
      pullFastForward: async (checkout: string) => { pulled.push(checkout); },
    };
    const env = { FORGE_SELF_REPO: 'owner/self', FORGE_REPO_CHECKOUTS: 'owner/self=' + join(h, 'co') } as NodeJS.ProcessEnv;
    const empty = () => ({ gotchas: [], events: [], runs: [], attestationRounds: [], runTranscripts: [], now: 1000 });
    const loop = buildSelfLoop({
      chainEnv: readChainEnv(env), store, mergeDeps: {} as never, runningHead: 'abc123', env, home: h, git, gather: empty, clock: () => 1000,
    });
    // An item mid-flight holds the cutover back.
    store.append({ id: 'Q-1', at: 1, source: 'ticket', input: 'X-1', ticket: 'X-1', state: 'running', createdAt: 1, updatedAt: 1 } as never);
    expect((await loop.tick()).restart).toBe(false);
    expect(pulled).toEqual([]);
    // Item 5 (2026-09-11): `review` used to read as idle and let the cutover through,
    // which is how a restart landed on top of a pending merge click. It now holds the
    // cutover back exactly as `running` does; only a terminal state lets it go.
    store.append({ id: 'Q-1', at: 2, state: 'review', updatedAt: 2 } as never);
    expect((await loop.tick()).restart).toBe(false);
    expect(pulled).toEqual([]);
    store.append({ id: 'Q-1', at: 3, state: 'done', updatedAt: 3 } as never);
    expect((await loop.tick()).restart).toBe(true);
    expect(pulled).toEqual([join(h, 'co')]);
  });

  it('never restarts onto the head it is already running', async () => {
    const h = home();
    const env = { FORGE_SELF_REPO: 'owner/self', FORGE_REPO_CHECKOUTS: 'owner/self=' + join(h, 'co') } as NodeJS.ProcessEnv;
    const loop = buildSelfLoop({
      chainEnv: readChainEnv(env), store: new QueueStore(join(h, 'q.jsonl')), mergeDeps: {} as never, runningHead: 'abc123', env, home: h,
      git: { fetch: async () => {}, remoteHead: async () => 'abc123', pullFastForward: async () => { throw new Error('must not pull'); } },
      gather: () => ({ gotchas: [], events: [], runs: [], attestationRounds: [], runTranscripts: [], now: 1000 }),
    });
    expect((await loop.tick()).restart).toBe(false);
  });
});
