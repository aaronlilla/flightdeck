/**
 * The ticket has to move on its own.
 *
 * `runPrOpenedHandoff` existed and nothing called it, so a pull request opened by a
 * worker still left its ticket reading Backlog. That is the board-lies defect one step
 * removed: the fix was written, shipped and never wired.
 *
 * These specimens drive the piece that closes the gap. The failure cases matter as much
 * as the success one: this runs fire-and-forget off a tool result in the turn stream, so
 * anything it throws would take the worker's own turn with it.
 */
import { describe, it, expect } from 'vitest';
import { handlePullRequestOpened, type OpenedPullRequest } from '../../../src/forge/intake/prOpenedWatch.ts';
import type { JiraWriteClient } from '../../../src/forge/intake/jira.ts';
import { resetReadabilityContractForTests } from '../../../src/forge/intake/readability.ts';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEUTRAL_SPECIMENS_SRC = path.join(__dirname, '..', 'specimens', 'readability');

const PR: OpenedPullRequest = {
  number: 162,
  title: 'ACME-290 Clear the tab bar on two more screens',
  url: 'https://github.com/acme/acme-app/pull/162',
};

let contractDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env['FORGE_READABILITY_DIR'];
  contractDir = mkdtempSync(path.join(tmpdir(), 'forge-propenedwatch-'));
  cpSync(NEUTRAL_SPECIMENS_SRC, contractDir, { recursive: true });
  process.env['FORGE_READABILITY_DIR'] = contractDir;
  resetReadabilityContractForTests();
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env['FORGE_READABILITY_DIR'];
  else process.env['FORGE_READABILITY_DIR'] = originalEnv;
  resetReadabilityContractForTests();
  rmSync(contractDir, { recursive: true, force: true });
});

function recordingClient() {
  const calls: string[] = [];
  const client: JiraWriteClient = {
    async comment(key) { calls.push(`comment:${key}`); return { ok: true }; },
    async assign(key, id) { calls.push(`assign:${key}:${id}`); return { ok: true, status: 204 }; },
    async transition(key, id) { calls.push(`transition:${key}:${id}`); return { ok: true, status: 204 }; },
    async link(key) { calls.push(`link:${key}`); return { ok: true, status: 201 }; },
  };
  return { client, calls };
}

describe('handlePullRequestOpened', () => {
  it('moves the ticket the pull request at that checkout names', async () => {
    const { client, calls } = recordingClient();
    const events: string[] = [];
    const result = await handlePullRequestOpened('/work/worktrees/acme-app--x', {
      readPrAt: async () => PR,
      client: () => client,
      env: () => ({ wipAccountId: 'acct-1', wipTransitionId: '21' }),
      emit: (event) => events.push(event.event),
    });
    expect(calls).toEqual(['assign:ACME-290:acct-1', 'transition:ACME-290:21', 'link:ACME-290']);
    expect(result?.failed).toBe(0);
    expect(events).toContain('pr-opened.assigned');
  });

  it('reads the pull request rather than the command, so a title from an editor still works', async () => {
    const { client, calls } = recordingClient();
    const seen: string[] = [];
    await handlePullRequestOpened('/work/worktrees/acme-app--x', {
      readPrAt: async (cwd) => { seen.push(cwd); return PR; },
      client: () => client,
      env: () => ({ wipAccountId: 'acct-1' }),
      emit: () => {},
    });
    expect(seen).toEqual(['/work/worktrees/acme-app--x']);
    expect(calls).toContain('assign:ACME-290:acct-1');
  });

  it('says why nothing moved when no pull request can be read', async () => {
    const events: { event: string; body?: string }[] = [];
    const result = await handlePullRequestOpened('/work/x', {
      readPrAt: async () => null,
      client: () => { throw new Error('must not be reached'); },
      env: () => ({}),
      emit: (event) => events.push(event as { event: string; body?: string }),
    });
    expect(result).toBeNull();
    expect(events[0]?.event).toBe('pr-opened.skipped');
    expect(events[0]?.body).toContain('no pull request found');
  });

  it('says why nothing moved when no credentials are configured', async () => {
    const events: { event: string; body?: string }[] = [];
    await handlePullRequestOpened('/work/x', {
      readPrAt: async () => PR,
      client: () => null,
      env: () => ({}),
      emit: (event) => events.push(event as { event: string; body?: string }),
    });
    expect(events[0]?.event).toBe('pr-opened.skipped');
    expect(events[0]?.body).toContain('no tracker credentials');
  });

  // It runs fire-and-forget off the turn stream. Throwing here would take the worker's
  // own turn down with it, so every failure has to come back as an event.
  it('never throws when reading the pull request fails', async () => {
    const events: { event: string; body?: string }[] = [];
    const result = await handlePullRequestOpened('/work/x', {
      readPrAt: async () => { throw new Error('gh: not authenticated'); },
      client: () => null,
      env: () => ({}),
      emit: (event) => events.push(event as { event: string; body?: string }),
    });
    expect(result).toBeNull();
    expect(events[0]?.body).toContain('gh: not authenticated');
  });

  it('never throws when the handoff itself fails', async () => {
    const events: { event: string; body?: string }[] = [];
    const exploding: JiraWriteClient = {
      async comment() { return { ok: true }; },
      async assign() { throw new Error('socket hang up'); },
      async transition() { return { ok: true }; },
      async link() { return { ok: true }; },
    };
    const result = await handlePullRequestOpened('/work/x', {
      readPrAt: async () => PR,
      client: () => exploding,
      env: () => ({ wipAccountId: 'acct-1' }),
      emit: (event) => events.push(event as { event: string; body?: string }),
    });
    expect(result).toBeNull();
    expect(events.some((e) => e.body?.includes('socket hang up'))).toBe(true);
  });

  it('changes nothing when the pull request title carries no ticket key', async () => {
    const { client, calls } = recordingClient();
    const events: string[] = [];
    await handlePullRequestOpened('/work/x', {
      readPrAt: async () => ({ ...PR, title: 'Clear the tab bar on two more screens' }),
      client: () => client,
      env: () => ({ wipAccountId: 'acct-1', wipTransitionId: '21' }),
      emit: (event) => events.push(event.event),
    });
    expect(calls).toEqual([]);
    expect(events).toEqual(['pr-opened.no-key']);
  });
});
