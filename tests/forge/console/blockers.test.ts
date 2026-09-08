/**
 * Detection of every blocker kind from fixtures shaped like the live sources, the chain
 * order for the billing -> checks -> question case, and `orderChains`' own shape rules.
 */
import { describe, expect, it } from 'vitest';

import { detectBlockers, orderChains, type DetectionInputs } from '../../../src/forge/console/blockers.js';

function baseInputs(overrides: Partial<DetectionInputs> = {}): DetectionInputs {
  return {
    now: 1_000_000,
    asks: [],
    integrations: [],
    lanes: [],
    billing: [],
    registryLive: new Set(),
    ...overrides,
  };
}

describe('detectBlockers: question', () => {
  it('reads an open inbox ask as a question blocker a person can resolve', () => {
    const [blocker] = detectBlockers(baseInputs({
      asks: [{ key: 'abc123', question: 'PR #39 is open. Can you fix billing?', runs: ['S-run1'], at: 500 }],
      lanes: [{ id: 'S-run1', title: 'stale-session fix', repo: null, state: 'parked', observedAt: 500, pr: null, mergeable: null }],
    }));
    expect(blocker!.id).toBe('question:abc123');
    expect(blocker!.kind).toBe('question');
    expect(blocker!.youCanResolve).toBe(true);
    expect(blocker!.blocks).toEqual([{ laneId: 'S-run1', label: 'stale-session fix' }]);
  });

  it('skips an ask that already has an answer', () => {
    const blockers = detectBlockers(baseInputs({
      asks: [{ key: 'abc123', question: 'dev or prod?', answer: 'dev', runs: [], at: 500 }],
    }));
    expect(blockers).toHaveLength(0);
  });
});

describe('detectBlockers: integration', () => {
  it('reads a down integration row, naming its dependent lanes', () => {
    const [blocker] = detectBlockers(baseInputs({
      integrations: [{
        id: 'github', name: 'GitHub', status: 'down', cause: 'gh auth status exited 1',
        fix: 'Reconnect via SSO, then blocked lanes resume.', fixLabel: 'Reconnect via SSO',
        since: 900, dependents: ['S-run1'],
      }],
      lanes: [{ id: 'S-run1', title: 'stale-session fix', repo: null, state: 'blocked', observedAt: 900, pr: null, mergeable: null }],
    }));
    expect(blocker!.id).toBe('integration:github');
    expect(blocker!.blocks).toEqual([{ laneId: 'S-run1', label: 'stale-session fix' }]);
    expect(blocker!.since).toBe(900);
  });

  it('never reads an ok integration as a blocker', () => {
    const blockers = detectBlockers(baseInputs({
      integrations: [{ id: 'github', name: 'GitHub', status: 'ok', cause: null, fix: null, fixLabel: null, since: null, dependents: [] }],
    }));
    expect(blockers).toHaveLength(0);
  });

  // Item 7: the live board listed Amplitude, context7 and knowledge -- MCP servers
  // nothing on the board depends on -- as blockers. A down integration only belongs
  // here when something actually waits on it.
  it('a down integration with no dependents and no blocked lane yields no blocker', () => {
    const blockers = detectBlockers(baseInputs({
      integrations: [{
        id: 'amplitude', name: 'Amplitude', status: 'down', cause: 'no route to host',
        fix: null, fixLabel: null, since: 900, dependents: [],
      }],
    }));
    expect(blockers).toHaveLength(0);
  });

  it('the same down integration with one dependent lane yields one blocker', () => {
    const blockers = detectBlockers(baseInputs({
      integrations: [{
        id: 'amplitude', name: 'Amplitude', status: 'down', cause: 'no route to host',
        fix: null, fixLabel: null, since: 900, dependents: ['S-run1'],
      }],
      lanes: [{ id: 'S-run1', title: 'ship analytics', repo: null, state: 'blocked', observedAt: 900, pr: null, mergeable: null }],
    }));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.id).toBe('integration:amplitude');
  });
});

describe('detectBlockers: checks', () => {
  it('reads a lane with failing checks on its PR', () => {
    const [blocker] = detectBlockers(baseInputs({
      lanes: [{
        id: 'S-run1', title: 'stale-session fix', repo: 'aaronlilla/flightdeck', state: 'blocked', observedAt: 500,
        pr: { no: 39, checks: 'failure' }, mergeable: null,
      }],
    }));
    expect(blocker!.id).toBe('checks:aaronlilla/flightdeck#39');
    expect(blocker!.blocks).toEqual([{ laneId: 'S-run1', label: 'stale-session fix' }]);
  });

  it('folds two lanes sharing one PR into one blocker', () => {
    const lanes: DetectionInputs['lanes'] = [
      { id: 'S-run1', title: 'a', repo: 'o/r', state: 'blocked', observedAt: 1, pr: { no: 5, checks: 'failure' }, mergeable: null },
      { id: 'S-run2', title: 'b', repo: 'o/r', state: 'blocked', observedAt: 1, pr: { no: 5, checks: 'failure' }, mergeable: null },
    ];
    const blockers = detectBlockers(baseInputs({ lanes }));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.blocks).toHaveLength(2);
  });

  // Item 8: the live view printed a 120-character title twice per step, and a ticket
  // key -- when there is one -- is what a person actually recognizes a lane by.
  it('labels a lane by its ticket key when it has one, ahead of its title', () => {
    const [blocker] = detectBlockers(baseInputs({
      lanes: [{
        id: 'S-run1', title: 'stale-session fix', ticket: 'BBZ-96', repo: 'o/r', state: 'blocked', observedAt: 500,
        pr: { no: 39, checks: 'failure' }, mergeable: null,
      }],
    }));
    expect(blocker!.blocks).toEqual([{ laneId: 'S-run1', label: 'BBZ-96' }]);
  });

  it('trims a long title to 60 characters at a word boundary, never the raw 120-character title', () => {
    const longTitle = 'dedupe warden.health on an open unregistered trip that was never claimed by any lane in the registry at all';
    const [blocker] = detectBlockers(baseInputs({
      lanes: [{
        id: 'S-run1', title: longTitle, repo: 'o/r', state: 'blocked', observedAt: 500,
        pr: { no: 39, checks: 'failure' }, mergeable: null,
      }],
    }));
    const label = blocker!.blocks[0]!.label;
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label).not.toBe(longTitle);
    expect(longTitle.startsWith(label)).toBe(true);
  });

  // Item 8: `since` is the failed run's own time, not the moment the Blockers view
  // happened to be opened -- `inputs.now` was standing in for both.
  it('reads since off the affected lane\'s own observedAt, not the view\'s open time', () => {
    const [blocker] = detectBlockers(baseInputs({
      now: 999_000,
      lanes: [{
        id: 'S-run1', title: 'stale-session fix', repo: 'o/r', state: 'blocked', observedAt: 500,
        pr: { no: 39, checks: 'failure' }, mergeable: null,
      }],
    }));
    expect(blocker!.since).toBe(500);
  });
});

describe('detectBlockers: billing', () => {
  it('reads a refused Actions run as a billing blocker with the settings link', () => {
    const [blocker] = detectBlockers(baseInputs({
      billing: [{
        repo: 'aaronlilla/flightdeck', pr: 39, runId: 'run-1', headSha: 'f284c65',
        message: 'The job was not started because recent account payments have failed or your spending limit needs to be increased',
      }],
    }));
    expect(blocker!.id).toBe('billing:aaronlilla/flightdeck');
    expect(blocker!.links).toContainEqual({ label: 'GitHub billing settings', url: 'https://github.com/settings/billing' });
  });

  // Item 8: the same since-is-view-open-time bug applied to billing blockers.
  it('reads since off the affected lane\'s own observedAt, not the view\'s open time', () => {
    const [blocker] = detectBlockers(baseInputs({
      now: 999_000,
      billing: [{
        repo: 'aaronlilla/flightdeck', pr: 39, runId: 'run-1', headSha: 'f284c65',
        message: 'payments have failed',
      }],
      lanes: [{
        id: 'S-run1', title: 'stale-session fix', repo: 'aaronlilla/flightdeck', state: 'blocked', observedAt: 700,
        pr: { no: 39, checks: 'failure' }, mergeable: null,
      }],
    }));
    expect(blocker!.since).toBe(700);
  });
});

describe('detectBlockers: owner', () => {
  it('reads a controlled-repo PR waiting on its named owner, not resolvable by you', () => {
    const [blocker] = detectBlockers(baseInputs({
      lanes: [{
        id: 'S-run1', title: 'widgets fix', repo: 'acme/widgets-api', state: 'blocked', observedAt: 1,
        pr: { no: 80, checks: 'success' }, mergeable: { ok: false, why: 'controlled code: only joe-at-bb merges this repo' },
      }],
    }));
    expect(blocker!.id).toBe('owner:acme/widgets-api#80');
    expect(blocker!.youCanResolve).toBe(false);
  });

  it('never reads an ordinary not-ready reason as an owner blocker', () => {
    const blockers = detectBlockers(baseInputs({
      lanes: [{
        id: 'S-run1', title: 'x', repo: 'o/r', state: 'blocked', observedAt: 1,
        pr: { no: 1, checks: 'pending' }, mergeable: { ok: false, why: 'checks pending' },
      }],
    }));
    expect(blockers.filter((b) => b.kind === 'owner')).toHaveLength(0);
  });
});

describe('detectBlockers: process', () => {
  it('reads a running lane with no live registry row for over 10 minutes', () => {
    const [blocker] = detectBlockers(baseInputs({
      now: 1_000_000,
      lanes: [{ id: 'S-b9d39bae', title: null, repo: null, state: 'running', observedAt: 1_000_000 - 11 * 60_000, pr: null, mergeable: null }],
      registryLive: new Set(),
    }));
    expect(blocker!.id).toBe('process:S-b9d39bae');
  });

  it('never flags a running lane that still has a live registry row', () => {
    const blockers = detectBlockers(baseInputs({
      now: 1_000_000,
      lanes: [{ id: 'S-run1', title: null, repo: null, state: 'running', observedAt: 1_000_000 - 20 * 60_000, pr: null, mergeable: null }],
      registryLive: new Set(['S-run1']),
    }));
    expect(blockers).toHaveLength(0);
  });

  it('never flags a running lane under the 10-minute grace period', () => {
    const blockers = detectBlockers(baseInputs({
      now: 1_000_000,
      lanes: [{ id: 'S-run1', title: null, repo: null, state: 'running', observedAt: 1_000_000 - 2 * 60_000, pr: null, mergeable: null }],
      registryLive: new Set(),
    }));
    expect(blockers).toHaveLength(0);
  });
});

describe('the billing -> checks -> question chain', () => {
  it('orders root-first: billing, then checks, then the question naming the same PR', () => {
    const inputs = baseInputs({
      billing: [{ repo: 'aaronlilla/flightdeck', pr: 39, runId: 'run-1', headSha: 'f284c65', message: 'recent account payments have failed' }],
      lanes: [{
        id: 'S-run1', title: 'stale-session fix', repo: 'aaronlilla/flightdeck', state: 'blocked', observedAt: 1,
        pr: { no: 39, checks: 'failure' }, mergeable: null,
      }],
      asks: [{ key: 'q1', question: 'PR #39 is open... Can you fix billing?', runs: ['S-run1'], at: 1 }],
    });
    const blockers = detectBlockers(inputs);
    const chains = orderChains(blockers);
    const billingChain = chains.find((c) => c[0] === 'billing:aaronlilla/flightdeck');
    expect(billingChain).toEqual([
      'billing:aaronlilla/flightdeck',
      'checks:aaronlilla/flightdeck#39',
      'question:q1',
    ]);
  });
});

describe('orderChains', () => {
  it('gives an unrelated blocker its own one-step chain', () => {
    const blockers = detectBlockers(baseInputs({
      integrations: [{
        id: 'jira', name: 'Jira', status: 'down', cause: null, fix: null, fixLabel: null, since: null,
        dependents: ['S-run1'],
      }],
      lanes: [{ id: 'S-run1', title: 'file the ticket', repo: null, state: 'blocked', observedAt: 1, pr: null, mergeable: null }],
    }));
    expect(orderChains(blockers)).toEqual([['integration:jira']]);
  });
});
