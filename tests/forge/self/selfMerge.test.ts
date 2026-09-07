import { describe, expect, it, vi } from 'vitest';

import {
  isRuntimePathChange, runSelfMerge, selfMergeAllowed, type SelfMergeAttestation, type SelfMergeChecks,
} from '../../../src/forge/self/selfMerge.js';
import type { QueueItem } from '../../../src/shared/console-model.js';
import type { QueueMergeDeps } from '../../../src/forge/intake/queue.js';

function attestation(overrides: Partial<SelfMergeAttestation> = {}): SelfMergeAttestation {
  return { verdict: 'PASS', coverage: { total: 4, missing: [] }, ...overrides };
}

function checks(overrides: Partial<SelfMergeChecks> = {}): SelfMergeChecks {
  return { conclusion: 'success', ...overrides };
}

const baseInput = {
  repo: 'owner/flightdeck', selfRepo: 'owner/flightdeck', selfMergeEnabled: true,
  attestation: attestation(), checks: checks(), changedFiles: ['README.md'], probeOk: undefined as boolean | undefined,
};

describe('isRuntimePathChange', () => {
  it('is false for a doc-only change', () => {
    expect(isRuntimePathChange(['README.md', 'src/forge/self/analyze.ts'])).toBe(false);
  });

  it('is true for a change touching the sdk engine', () => {
    expect(isRuntimePathChange(['src/forge/sdkengine.ts'])).toBe(true);
  });

  it('is true for a change touching the cli', () => {
    expect(isRuntimePathChange(['src/forge/cli.ts'])).toBe(true);
  });

  it('is true for a change touching the adapter engine', () => {
    expect(isRuntimePathChange(['src/adapter/engine.ts'])).toBe(true);
  });
});

describe('selfMergeAllowed', () => {
  it('allows a clean self-repo item with no runtime-path files', () => {
    const result = selfMergeAllowed(baseInput);
    expect(result.ok).toBe(true);
  });

  it('refuses a repo other than FORGE_SELF_REPO', () => {
    const result = selfMergeAllowed({ ...baseInput, repo: 'owner/other' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/repo/i);
  });

  it('refuses when FORGE_SELF_MERGE is off', () => {
    const result = selfMergeAllowed({ ...baseInput, selfMergeEnabled: false });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/FORGE_SELF_MERGE/);
  });

  it('refuses a verdict other than PASS/PASS WITH NOTES', () => {
    const result = selfMergeAllowed({ ...baseInput, attestation: attestation({ verdict: 'FIX FIRST' }) });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/verdict/i);
  });

  it('refuses coverage with any missing member', () => {
    const result = selfMergeAllowed({
      ...baseInput, attestation: attestation({ coverage: { total: 4, missing: ['scope-conformance'] } }),
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/coverage/i);
  });

  it('refuses coverage total less than 4', () => {
    const result = selfMergeAllowed({ ...baseInput, attestation: attestation({ coverage: { total: 3, missing: [] } }) });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/4/);
  });

  it('refuses when PR checks are not a success', () => {
    const result = selfMergeAllowed({ ...baseInput, checks: checks({ conclusion: 'pending' }) });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/checks/i);
  });

  it('refuses with no attestation at all', () => {
    const result = selfMergeAllowed({ ...baseInput, attestation: undefined });
    expect(result.ok).toBe(false);
  });

  it('requires a passing probe result when a runtime-path file changed', () => {
    const result = selfMergeAllowed({ ...baseInput, changedFiles: ['src/forge/worker.ts'], probeOk: undefined });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/probe/i);
  });

  it('refuses when the probe result says it failed', () => {
    const result = selfMergeAllowed({ ...baseInput, changedFiles: ['src/forge/worker.ts'], probeOk: false });
    expect(result.ok).toBe(false);
  });

  it('allows a runtime-path change once the probe passed', () => {
    const result = selfMergeAllowed({ ...baseInput, changedFiles: ['src/forge/worker.ts'], probeOk: true });
    expect(result.ok).toBe(true);
  });

  it('allows PASS WITH NOTES the same as PASS', () => {
    const result = selfMergeAllowed({ ...baseInput, attestation: attestation({ verdict: 'PASS WITH NOTES' }) });
    expect(result.ok).toBe(true);
  });
});

function queueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'S-f1', source: 'brief', input: 'x', ticket: 'S-f1', repo: 'owner/flightdeck', briefPath: 'b.md',
    branch: 'feature/s-f1', worktreePath: 'wt', base: 'main', state: 'review', reason: null, runKey: 'r1',
    pr: { no: 5, url: 'https://example.invalid/pull/5', files: 1, add: 1, del: 0, draft: true },
    journalIds: [], createdAt: 0, updatedAt: 0, ...overrides,
  };
}

describe('runSelfMerge', () => {
  it('calls mergeItem and journals self.merged when the policy allows it', async () => {
    const gate = vi.fn().mockResolvedValue({ merged: true, mergeSha: 'abc' });
    const appended: Array<Record<string, unknown>> = [];
    const mergeDeps: QueueMergeDeps = {
      mergeAllowed: () => true, gate, clock: () => 42, store: { append: vi.fn() } as unknown as QueueMergeDeps['store'],
    };
    const result = await runSelfMerge(queueItem(), baseInput, mergeDeps, (e) => { appended.push(e); return { id: 'j1' }; });
    expect(result.ok).toBe(true);
    expect(gate).toHaveBeenCalledWith({ repo: 'owner/flightdeck', pr: 5, merge: true });
    expect(appended.map((e) => e['event'])).toContain('self.merged');
  });

  it('never calls mergeItem when the policy refuses, and journals self.merge-refused', async () => {
    const gate = vi.fn();
    const appended: Array<Record<string, unknown>> = [];
    const mergeDeps: QueueMergeDeps = {
      mergeAllowed: () => true, gate, clock: () => 42, store: { append: vi.fn() } as unknown as QueueMergeDeps['store'],
    };
    const result = await runSelfMerge(
      queueItem(), { ...baseInput, selfMergeEnabled: false }, mergeDeps, (e) => { appended.push(e); return { id: 'j1' }; },
    );
    expect(result.ok).toBe(false);
    expect(gate).not.toHaveBeenCalled();
    expect(appended.map((e) => e['event'])).toContain('self.merge-refused');
  });
});
