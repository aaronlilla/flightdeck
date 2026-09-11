import { describe, expect, test, vi } from 'vitest';

vi.mock('../../../../src/forge/sessions/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/forge/sessions/registry.js')>();
  return { ...actual, scanSessions: vi.fn(() => []) };
});
vi.mock('../../../../src/forge/journal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/forge/journal.js')>();
  return {
    ...actual,
    replay: vi.fn(() => ({ events: [], runs: {}, burn: {}, handoffs: 0, torn: 0, unknownModels: [], sessions: {} })),
    Journal: class {
      append(row: unknown) { return row; }
      close() { /* no-op fake */ }
    },
  };
});
vi.mock('../../../../src/forge/sessions/cleanup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/forge/sessions/cleanup.js')>();
  return { ...actual, sweepAndCollectLocks: vi.fn(() => ({ releasedLocks: [] })) };
});
vi.mock('../../../../src/forge/accounts-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/forge/accounts-service.js')>();
  return {
    ...actual,
    AccountsService: vi.fn(function (this: unknown) {
      Object.assign(this as object, { refreshAll: vi.fn(async () => {}), list: vi.fn(() => []) });
    }),
  };
});
vi.mock('../../../../src/forge/service/process-table.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/forge/service/process-table.js')>();
  return { ...actual, realProcessTable: vi.fn(() => []) };
});
vi.mock('../../../../src/forge/machine/snapshot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/forge/machine/snapshot.js')>();
  return { ...actual, buildMachineSnapshot: vi.fn(() => ({ counts: { sessions: 0, processes: 0, unregistered: 0 } })) };
});
vi.mock('../../../../src/forge/queue-wire.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/forge/queue-wire.js')>();
  return { ...actual, jiraConfigFromEnv: vi.fn(() => ({ site: 's', email: 'e', token: 't' })) };
});
vi.mock('../../../../src/forge/intake/jira.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/forge/intake/jira.js')>();
  return { ...actual, probeJira: vi.fn(async () => ({ ok: true, accountId: 'me-1' })) };
});
vi.mock('../../../../src/forge/intake/inbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/forge/intake/inbox.js')>();
  return {
    ...actual,
    fetchInboxIssues: vi.fn(async () => []),
    classifyInbox: vi.fn(() => ({ needsReply: [], awaitingOthers: [], statusDrift: [] })),
  };
});

const { scanSessions } = await import('../../../../src/forge/sessions/registry.js');
const { sweepAndCollectLocks } = await import('../../../../src/forge/sessions/cleanup.js');
const { AccountsService } = await import('../../../../src/forge/accounts-service.js');
const { realProcessTable } = await import('../../../../src/forge/service/process-table.js');
const { buildMachineSnapshot } = await import('../../../../src/forge/machine/snapshot.js');
const { fetchInboxIssues, classifyInbox } = await import('../../../../src/forge/intake/inbox.js');
const { buildPageDeps } = await import('../../../../src/forge/sync/pages/index.js');

describe('buildPageDeps', () => {
  test('returns five callables, each reaching its real production function', async () => {
    const recheck = vi.fn(async () => ({ status: 'ok' }));
    const deps = buildPageDeps({
      registry: { all: () => [] },
      consoleReads: {
        lanesResponse: () => ({ lanes: [{ id: 'lane-a' }] }),
        runRecheckResponse: recheck,
      },
    });

    expect(Object.keys(deps).sort()).toEqual(['accounts', 'inbox', 'lanes', 'machine', 'sessions']);

    await deps.sessions();
    expect(scanSessions).toHaveBeenCalled();
    expect(sweepAndCollectLocks).toHaveBeenCalled();

    await deps.accounts();
    expect(AccountsService).toHaveBeenCalled();

    await deps.machine();
    expect(realProcessTable).toHaveBeenCalled();
    expect(buildMachineSnapshot).toHaveBeenCalled();

    await deps.inbox();
    expect(fetchInboxIssues).toHaveBeenCalled();
    expect(classifyInbox).toHaveBeenCalled();

    await deps.lanes();
    expect(recheck).toHaveBeenCalledWith('lane-a');
  });
});
