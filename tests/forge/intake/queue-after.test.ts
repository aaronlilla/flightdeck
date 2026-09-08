/**
 * `after:` gating (`unresolvedAfterReason`/`slugMatches` in `queue.ts`, `queueBranchMerged`
 * in `queue-wire.ts`): a queued item naming `after: <slug>` entries holds until every entry
 * resolves, either against another queue item reaching `done` or against a real
 * `feature/<slug>` branch already merged into `origin/main`. Mirrors the fixture shape in
 * `tests/forge/intake/queue.test.ts` (a real `QueueStore` over a temp file, a locally built
 * `QueueRuntimeDeps`), plus one specimen that builds an actual git remote and checkout so
 * `queueBranchMerged` is proven against a real merged ref, never a stub standing in for it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ChainCouncilFn, ChainGateFn, ChainGh, ChainLauncher, ChainRunStatus } from '../../../src/forge/chain.js';
import {
  addTicketItem, runQueueTick,
  type QueuePlanner, type QueueRuntimeDeps,
} from '../../../src/forge/intake/queue.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import { queueBranchMerged } from '../../../src/forge/queue-wire.js';
import type { ChainEnv } from '../../../src/forge/chain-env.js';
import type { QueueItem } from '../../../src/shared/console-model.js';

function tempStore(): QueueStore {
  const dir = mkdtempSync(join(tmpdir(), 'queue-after-'));
  return new QueueStore(join(dir, 'queue.jsonl'));
}

interface FixtureOverrides {
  planner?: Partial<QueuePlanner>;
  launcher?: Partial<ChainLauncher>;
  gh?: Partial<ChainGh>;
  rebaseOnBase?: QueueRuntimeDeps['rebaseOnBase'];
  council?: ChainCouncilFn;
  gate?: ChainGateFn;
  killSwitch?: () => boolean;
  paused?: () => boolean;
  maxInFlight?: () => number;
  branchMerged?: QueueRuntimeDeps['branchMerged'];
}

function buildDeps(store: QueueStore, overrides: FixtureOverrides = {}): { deps: QueueRuntimeDeps; events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = [];
  let seq = 0;
  const deps: QueueRuntimeDeps = {
    planner: {
      planTicket: async (ticket) => ({ ticket, repo: 'owner/name', briefPath: `C:/briefs/${ticket}.md` }),
      planBrief: async () => ({ ticket: 'BRIEF-1', repo: 'owner/name', briefPath: 'C:/briefs/brief-1.md' }),
      ...overrides.planner,
    },
    launcher: {
      provision: async ({ ticket }) => ({
        worktreePath: `C:/worktrees/repo--${ticket.toLowerCase()}`, branch: `feature/${ticket.toLowerCase()}`, base: 'develop',
      }),
      launch: async ({ ticket }) => ({ runKey: ticket.toLowerCase() }),
      status: async (): Promise<ChainRunStatus> => ({ finished: false }),
      runRegistered: async () => false,
      ...overrides.launcher,
    },
    gh: {
      findPrByHead: async () => undefined,
      ...overrides.gh,
    },
    ...(overrides.rebaseOnBase ? { rebaseOnBase: overrides.rebaseOnBase } : {}),
    council: overrides.council ?? (async () => ({ verdict: 'PASS' })),
    gate: overrides.gate ?? (async () => ({ merged: false })),
    ...(overrides.branchMerged ? { branchMerged: overrides.branchMerged } : {}),
    clock: () => 1_000,
    killSwitch: overrides.killSwitch ?? (() => false),
    paused: overrides.paused ?? (() => false),
    maxInFlight: overrides.maxInFlight ?? (() => 5),
    append: (event) => {
      seq += 1;
      const id = `e${seq}`;
      events.push({ id, ...event });
      return { id };
    },
    store,
  };
  return { deps, events };
}

// `briefPath` defaults to `null`, mirroring a fresh, never-planned queued item
// (`blankItem` in `queue.ts`): a queued item with an unresolved `after` gate has never
// reached `advanceItem`'s planning hop, so it carries no brief yet either. A raw item
// meant to represent something already in flight (a running predecessor) overrides
// `briefPath`/`runKey`/`branch`/`worktreePath`/`base`/`state` explicitly.
function appendRaw(store: QueueStore, patch: Partial<QueueItem> & { id: string; input: string }): void {
  store.append({
    at: 1000, source: 'ticket', ticket: patch.ticket ?? patch.input, repo: 'owner/name',
    briefPath: null, branch: null, worktreePath: null, base: null,
    state: 'queued', reason: null, runKey: null, pr: null, journalIds: [], createdAt: 1000, updatedAt: 1000,
    ...patch,
  });
}

describe('runQueueTick: after gating', () => {
  it('starts two independent items together when neither carries after', async () => {
    const store = tempStore();
    addTicketItem(store, 'A-1', 1000);
    addTicketItem(store, 'A-2', 1000);
    const { deps } = buildDeps(store);

    const result = await runQueueTick(deps, store.all());
    expect(result.started).toBe(2);
    expect(store.all().every((item) => item.state === 'running')).toBe(true);
  });

  it('holds a dependent item queued while its predecessor is still running, then starts it once the predecessor is done', async () => {
    const store = tempStore();
    appendRaw(store, {
      id: 'q1', input: 'predecessor-slug', state: 'running', runKey: 'r1',
      briefPath: 'C:/briefs/predecessor.md', branch: 'feature/predecessor-slug',
      worktreePath: 'C:/worktrees/repo--predecessor', base: 'develop',
    });
    appendRaw(store, { id: 'q2', input: 'A-2', after: ['predecessor-slug'] });
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: false }) },
    });

    const first = await runQueueTick(deps, store.all());
    expect(first.started).toBe(0);
    expect(store.get('q2')).toMatchObject({ state: 'queued', reason: 'waiting on predecessor-slug' });

    store.append({ id: 'q1', at: 2000, state: 'done', updatedAt: 2000 });
    const second = await runQueueTick(deps, store.all());
    expect(second.started).toBe(1);
    expect(store.get('q2')?.state).toBe('running');
  });

  it('holds an item queued naming a slug that matches no queue item and no merged branch', async () => {
    const store = tempStore();
    appendRaw(store, { id: 'q1', input: 'A-1', after: ['nonexistent-slug'] });
    const { deps } = buildDeps(store, { branchMerged: async () => false });

    const result = await runQueueTick(deps, store.all());
    expect(result.started).toBe(0);
    expect(store.get('q1')).toMatchObject({ state: 'queued', reason: 'waiting on unknown item: nonexistent-slug' });
  });

  it('starts an item naming an unmatched slug once a fake branchMerged reports the feature branch merged', async () => {
    const store = tempStore();
    appendRaw(store, { id: 'q1', input: 'A-1', after: ['already-shipped'] });
    let askedRepo: string | undefined;
    let askedBranch: string | undefined;
    const { deps } = buildDeps(store, {
      branchMerged: async (repo, branch) => {
        askedRepo = repo;
        askedBranch = branch;
        return branch === 'feature/already-shipped';
      },
    });

    const result = await runQueueTick(deps, store.all());
    expect(result.started).toBe(1);
    expect(store.get('q1')?.state).toBe('running');
    expect(askedRepo).toBe('owner/name');
    expect(askedBranch).toBe('feature/already-shipped');
  });

  it('resolves an unmatched slug through the real queueBranchMerged, against an actual merged git ref -- and refuses an unmerged one', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'queue-after-git-'));
    const originPath = join(workDir, 'origin.git');
    const checkoutPath = join(workDir, 'checkout');
    const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'pipe' });

    git(['init', '--bare', '-b', 'main', originPath], workDir);
    git(['clone', originPath, checkoutPath], workDir);
    git(['config', 'user.email', 'queue-after-test@example.com'], checkoutPath);
    git(['config', 'user.name', 'Queue After Test'], checkoutPath);
    git(['commit', '--allow-empty', '-m', 'root'], checkoutPath);
    git(['push', 'origin', 'main'], checkoutPath);

    // A merged branch: created off main, pushed, then merged back and pushed to main.
    git(['checkout', '-b', 'feature/merged-slug'], checkoutPath);
    git(['commit', '--allow-empty', '-m', 'merged work'], checkoutPath);
    git(['push', 'origin', 'feature/merged-slug'], checkoutPath);
    git(['checkout', 'main'], checkoutPath);
    git(['merge', '--no-ff', 'feature/merged-slug', '-m', 'merge it'], checkoutPath);
    git(['push', 'origin', 'main'], checkoutPath);

    // An unmerged branch: created off main, pushed, never merged.
    git(['checkout', '-b', 'feature/unmerged-slug'], checkoutPath);
    git(['commit', '--allow-empty', '-m', 'unmerged work'], checkoutPath);
    git(['push', 'origin', 'feature/unmerged-slug'], checkoutPath);
    git(['checkout', 'main'], checkoutPath);

    const chainEnv: ChainEnv = {
      enabled: false, pollSeconds: 300,
      checkouts: [{ repo: 'owner/name', value: checkoutPath }],
      bases: [], worktreeSetup: [], verify: [], mergeRepos: [], forceCodex: false, repoKinds: [], shell: [],
    };
    const branchMerged = queueBranchMerged(chainEnv);

    await expect(branchMerged('owner/name', 'feature/merged-slug')).resolves.toBe(true);
    await expect(branchMerged('owner/name', 'feature/unmerged-slug')).resolves.toBe(false);

    const store = tempStore();
    appendRaw(store, { id: 'q1', input: 'A-1', repo: 'owner/name', after: ['merged-slug'] });
    appendRaw(store, { id: 'q2', input: 'A-2', repo: 'owner/name', after: ['unmerged-slug'] });
    const { deps } = buildDeps(store, { branchMerged });

    const result = await runQueueTick(deps, store.all());
    expect(result.started).toBe(1);
    expect(store.get('q1')?.state).toBe('running');
    expect(store.get('q2')).toMatchObject({ state: 'queued', reason: 'waiting on unknown item: unmerged-slug' });
  }, 30_000);
});
