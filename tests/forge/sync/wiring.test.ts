/**
 * R-73: proves the production wiring's nine `full`-scope stages are bound to real
 * code-sync (stream B) and page-sync (stream C) functions -- no stage may ship
 * `skipped` -- and that `POST /sync/full`'s confirm blast carries a real dry-run
 * worktree count instead of the "not wired yet" placeholder A shipped.
 *
 * Every external effect is injected: `execRun` fakes git/gh (real-deps.ts's own
 * override point), `sessionsDir` points at an empty temp dir (never
 * `.claude/coordination`), and the page-sync collaborators (sessions scan, accounts
 * service, machine snapshot, inbox fetch/classify, worktree status) are module-mocked
 * exactly as `tests/forge/sync/pages/index.test.ts` already does. Nothing here runs
 * real git, real gh, or touches port 4120.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunRequest, RunResult } from '../../../src/forge/exec.js';

vi.mock('../../../src/forge/sessions/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/forge/sessions/registry.js')>();
  return { ...actual, scanSessions: vi.fn(() => []) };
});
vi.mock('../../../src/forge/sessions/cleanup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/forge/sessions/cleanup.js')>();
  return {
    ...actual,
    sweepAndCollectLocks: vi.fn(() => ({ releasedLocks: [] })),
    worktreeStatusFor: vi.fn(() => ({ clean: true, pushed: true })),
    worktreeStatusForAsync: vi.fn(async () => ({ clean: true, pushed: true })),
  };
});
vi.mock('../../../src/forge/accounts-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/forge/accounts-service.js')>();
  return {
    ...actual,
    AccountsService: vi.fn(function (this: unknown) {
      Object.assign(this as object, { refreshAll: vi.fn(async () => {}), list: vi.fn(() => []) });
    }),
  };
});
vi.mock('../../../src/forge/service/process-table.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/forge/service/process-table.js')>();
  return { ...actual, realProcessTable: vi.fn(() => []) };
});
vi.mock('../../../src/forge/machine/snapshot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/forge/machine/snapshot.js')>();
  return { ...actual, buildMachineSnapshot: vi.fn(() => ({ counts: { sessions: 0, processes: 0, unregistered: 0 } })) };
});
vi.mock('../../../src/forge/queue-wire.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/forge/queue-wire.js')>();
  return { ...actual, jiraConfigFromEnv: vi.fn(() => ({ site: 's', email: 'e', token: 't' })) };
});
vi.mock('../../../src/forge/intake/jira.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/forge/intake/jira.js')>();
  return { ...actual, probeJira: vi.fn(async () => ({ ok: true, accountId: 'me-1' })) };
});
vi.mock('../../../src/forge/intake/inbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/forge/intake/inbox.js')>();
  return {
    ...actual,
    fetchInboxIssues: vi.fn(async () => []),
    classifyInbox: vi.fn(() => ({ needsReply: [], awaitingOthers: [], statusDrift: [] })),
  };
});
vi.mock('../../../src/forge/sync/jira-pull.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/forge/sync/jira-pull.js')>();
  return { ...actual, pullJira: vi.fn(async () => ({ added: [], reused: [], planned: [], skipped: [] })) };
});

const { QueueStore } = await import('../../../src/forge/intake/queueStore.js');
const { Journal } = await import('../../../src/forge/journal.js');
const { buildProductionSyncStages } = await import('../../../src/forge/sync/index.js');
const { createSyncRunner } = await import('../../../src/forge/sync/run.js');
const { SyncStore } = await import('../../../src/forge/sync/store.js');
const { SyncRoutes } = await import('../../../src/forge/sync/routes.js');
const { JiraWatcher } = await import('../../../src/forge/sync/watcher-state.js');

const FULL_STAGE_NAMES = [
  'stop-workers', 'wipe-queue', 'reset-watermarks',
  'fetch-repos', 'reconcile-prs', 'sweep-worktrees',
  'pull-jira', 'watcher-on', 'resume',
] as const;

/** A two-worktree porcelain listing: the main checkout plus two removable worktrees. */
const PORCELAIN = [
  'worktree /fake/checkout',
  'HEAD 0000000000000000000000000000000000000000',
  'branch refs/heads/main',
  '',
  'worktree /fake/checkout/wt-1',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/feature/wt-1',
  '',
  'worktree /fake/checkout/wt-2',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/feature/wt-2',
  '',
].join('\n');

const MERGED_PR = JSON.stringify([
  { number: 1, state: 'MERGED', mergedAt: '2026-09-01T00:00:00Z', headRefName: 'feature/wt-1' },
]);

function fakeResult(argv: string[], full: string): RunResult {
  return { owner: 'test', argv, returncode: 0, tail: full, full, startedAt: Date.now(), durationMs: 1, ok: true };
}

function fakeExecRun(): (request: RunRequest) => Promise<RunResult> {
  return async ({ argv }) => {
    if (argv[0] === 'git' && argv[1] === 'fetch') return fakeResult(argv, '');
    if (argv[0] === 'git' && argv[1] === 'worktree' && argv[2] === 'list') return fakeResult(argv, PORCELAIN);
    if (argv[0] === 'git' && argv[1] === 'worktree' && argv[2] === 'remove') return fakeResult(argv, '');
    if (argv[0] === 'git' && argv[1] === 'branch' && argv[2] === '-D') return fakeResult(argv, '');
    if (argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'list') return fakeResult(argv, MERGED_PR);
    throw new Error(`fakeExecRun: unexpected argv ${JSON.stringify(argv)}`);
  };
}

let dir: string;
let originalForgeHome: string | undefined;
let originalBacklogProject: string | undefined;
let originalCheckouts: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-wiring-'));
  originalForgeHome = process.env['FORGE_HOME'];
  originalBacklogProject = process.env['FORGE_BACKLOG_PROJECT'];
  originalCheckouts = process.env['FORGE_REPO_CHECKOUTS'];
  process.env['FORGE_HOME'] = dir;
  process.env['FORGE_BACKLOG_PROJECT'] = 'BBZ';
  process.env['FORGE_REPO_CHECKOUTS'] = 'aaronlilla/flightdeck=/fake/checkout';
});

afterEach(() => {
  if (originalForgeHome === undefined) delete process.env['FORGE_HOME']; else process.env['FORGE_HOME'] = originalForgeHome;
  if (originalBacklogProject === undefined) delete process.env['FORGE_BACKLOG_PROJECT']; else process.env['FORGE_BACKLOG_PROJECT'] = originalBacklogProject;
  if (originalCheckouts === undefined) delete process.env['FORGE_REPO_CHECKOUTS']; else process.env['FORGE_REPO_CHECKOUTS'] = originalCheckouts;
});

function buildWiring(overrideExecRun?: (request: RunRequest) => Promise<RunResult>) {
  const queueStore = new QueueStore(join(dir, 'console', 'queue.jsonl'));
  queueStore.append({ id: 'q1', at: Date.now(), ticket: 'BBZ-1', updatedAt: Date.now() });
  const journal = new Journal(join(dir, 'fleet.jsonl'));
  const watcher = new JiraWatcher({
    jiraConfig: () => undefined,
    watermarks: { get: () => ({ source: 'jira', committedAt: 0, idsAtCommittedAt: [] }), set: () => {} },
    store: queueStore, journal,
  });
  const sessionsDir = mkdtempSync(join(tmpdir(), 'sync-wiring-sessions-'));

  return buildProductionSyncStages({
    queueStore, watcher, journal,
    registry: { all: () => [] },
    consoleReads: {
      lanesResponse: () => ({ lanes: [{ id: 'lane-a' }] }),
      runRecheckResponse: async () => ({ status: 'ok' }),
    },
    execRun: overrideExecRun ?? fakeExecRun(),
    sessionsDir,
  });
}

describe('production sync wiring: nine full-scope stages', () => {
  it('binds every B and C stage so none reports skipped, and feeds the dry-run worktree count into the confirm blast', async () => {
    const wiring = buildWiring();
    const store = new SyncStore(join(dir, 'console', 'sync.json'));
    const journal = new Journal(join(dir, 'fleet.jsonl'));
    const runner = createSyncRunner({ stages: wiring.stages, journal, store });

    const record = await runner.runSync('full');
    journal.close();

    const byName = Object.fromEntries(record.stages.map((s) => [s.name, s]));
    for (const name of FULL_STAGE_NAMES) {
      expect(byName[name]?.status, `stage "${name}" was ${byName[name]?.status}`).not.toBe('skipped');
    }
    expect(record.ok).toBe(true);

    const routes = new SyncRoutes({
      runner, store,
      watcher: { status: () => ({ on: false, project: null, pollSeconds: 300 }), start: async () => {}, stop: () => {} } as never,
      authorized: () => true,
      blastCounts: () => ({ queueItems: 0, runningWorkers: 0 }),
      confirmGate: async (_body, _source, blast) => ({ status: 202, body: { ok: false, pending: true, blast, token: 'test-token' } }),
    });

    let captured: { status: number; body: unknown } | undefined;
    const response = {
      writeHead: () => {},
      end: (text: string) => { captured = { status: 200, body: JSON.parse(text) }; },
    };
    await routes.handle('/sync/full', { method: 'POST', on: (event: string, cb: (...a: unknown[]) => void) => { if (event === 'end') cb(); } } as never, response as never);

    const blast = (captured?.body as { blast: string }).blast;
    expect(blast).toContain('sweep merged and closed worktrees');
    expect(blast).not.toContain('not wired yet');
    expect(blast).not.toContain('not ready in time');
  });
});
