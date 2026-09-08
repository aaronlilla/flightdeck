/**
 * `BlockersRoutes`: confirmation moves a blocker to resolved and restarts exactly the
 * lanes whose chain is clear, a cause that vanishes on its own reads `resolved` with no
 * click, and the ledger survives a reload (a fresh instance over the same file sees
 * what an earlier one wrote).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BlockersRoutes, type BlockersRoutesOptions } from '../../../src/forge/console/blockers-route.js';
import type { DetectionInputs } from '../../../src/forge/console/blockers.js';

let dir: string;
let ledgerPath: string;
let journalPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blockers-route-'));
  ledgerPath = join(dir, 'blockers.jsonl');
  journalPath = join(dir, 'fleet.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function opts(overrides: Partial<BlockersRoutesOptions> & { gather: () => Promise<DetectionInputs> }): BlockersRoutesOptions {
  return {
    ledgerPath, journalPath, authorized: () => true, confirmers: {}, restarters: {}, ...overrides,
  };
}

const billingInputs = (): DetectionInputs => ({
  now: 1_000_000,
  asks: [],
  integrations: [],
  lanes: [{
    id: 'S-run1', title: 'stale-session fix', repo: 'aaronlilla/flightdeck', state: 'blocked', observedAt: 1,
    pr: { no: 39, checks: 'failure' }, mergeable: null,
  }],
  billing: [{ repo: 'aaronlilla/flightdeck', pr: 39, runId: 'run-1', headSha: 'f284c65', message: 'billing is off' }],
  registryLive: new Set(),
});

describe('GET /blockers', () => {
  it('lists a live blocker as open with its chain', async () => {
    const routes = new BlockersRoutes(opts({ gather: async () => billingInputs() }));
    const result = await routes.list();
    expect(result.blockers.map((b) => b.id).sort()).toEqual(['billing:aaronlilla/flightdeck', 'checks:aaronlilla/flightdeck#39']);
    expect(result.blockers.every((b) => b.state === 'open')).toBe(true);
    expect(result.chains).toEqual([['billing:aaronlilla/flightdeck', 'checks:aaronlilla/flightdeck#39']]);
  });

  it('reads a blocker resolved once its cause is gone from the sources, with no click', async () => {
    let live = true;
    const routes = new BlockersRoutes(opts({
      gather: async () => (live ? billingInputs() : { ...billingInputs(), billing: [], lanes: [] }),
    }));
    await routes.list();
    live = false;
    const after = await routes.list();
    const billing = after.blockers.find((b) => b.id === 'billing:aaronlilla/flightdeck');
    expect(billing?.state).toBe('resolved');
    expect(billing?.resolvedAt).not.toBeNull();
  });
});

describe('POST /blockers/:id/resolve', () => {
  it('moves state to resolved and restarts exactly the lanes whose whole chain is clear', async () => {
    const started: string[] = [];
    let billingCleared = false;
    const routes = new BlockersRoutes(opts({
      gather: async () => (billingCleared ? { ...billingInputs(), billing: [], lanes: [] } : billingInputs()),
      confirmers: {
        billing: async () => { billingCleared = true; return { ok: true, detail: 'billing is back on' }; },
      },
      restarters: {
        billing: async (_blocker, laneIds) => { started.push(...laneIds); return laneIds; },
      },
    }));
    const result = await routes.resolve('billing:aaronlilla/flightdeck');
    expect(result.ok).toBe(true);
    expect(result.state).toBe('resolved');
    expect(result.started).toEqual(['S-run1']);
    expect(started).toEqual(['S-run1']);
  });

  it('never restarts a lane still blocked by another open blocker in the chain', async () => {
    // The checks blocker on the same lane never clears here, so a billing confirmation
    // alone must not restart the lane it shares with an unresolved `checks` blocker.
    const started: string[] = [];
    const routes = new BlockersRoutes(opts({
      gather: async () => billingInputs(), // checks:...#39 stays open forever in this fixture
      confirmers: { billing: async () => ({ ok: true, detail: 'billing is back on' }) },
      restarters: { billing: async (_b, laneIds) => { started.push(...laneIds); return laneIds; } },
    }));
    const result = await routes.resolve('billing:aaronlilla/flightdeck');
    expect(result.ok).toBe(true);
    expect(result.started).toEqual([]);
    expect(started).toEqual([]);
  });

  it('reports not-yet when the confirmation fails, and leaves the blocker open', async () => {
    const routes = new BlockersRoutes(opts({
      gather: async () => billingInputs(),
      confirmers: { billing: async () => ({ ok: false, detail: 'still refused' }) },
    }));
    const result = await routes.resolve('billing:aaronlilla/flightdeck');
    expect(result.ok).toBe(false);
    expect(result.state).toBe('open');
    expect(result.lastCheck).toBe('still refused');
  });

  it('refuses a resolve claim on a blocker nobody can resolve', async () => {
    const inputs: DetectionInputs = {
      now: 1, asks: [], integrations: [], billing: [], registryLive: new Set(),
      lanes: [{
        id: 'S-run1', title: 'BBMS fix', repo: 'boltbetz/BBManagementSystemV2', state: 'blocked', observedAt: 1,
        pr: { no: 80, checks: 'success' }, mergeable: { ok: false, why: 'controlled code: only joe-at-bb merges this repo' },
      }],
    };
    const routes = new BlockersRoutes(opts({ gather: async () => inputs }));
    const result = await routes.resolve('owner:boltbetz/BBManagementSystemV2#80');
    expect(result.ok).toBe(false);
    expect(result.state).toBe('open');
  });
});

describe('the ledger survives a reload', () => {
  it('a fresh BlockersRoutes instance over the same file sees the earlier resolution', async () => {
    let billingCleared = false;
    const shared = {
      gather: async () => (billingCleared ? { ...billingInputs(), billing: [], lanes: [] } : billingInputs()),
      confirmers: { billing: async () => { billingCleared = true; return { ok: true, detail: 'billing is back on' }; } },
    };
    const first = new BlockersRoutes(opts(shared));
    await first.resolve('billing:aaronlilla/flightdeck');

    const second = new BlockersRoutes(opts(shared));
    const result = await second.list();
    const billing = result.blockers.find((b) => b.id === 'billing:aaronlilla/flightdeck');
    expect(billing?.state).toBe('resolved');
    expect(billing?.lastCheck).toBe('billing is back on');
  });
});
