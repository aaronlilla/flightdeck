/**
 * Requirement 6: the Intake planner always reasons on `claude`. The old Codex planning
 * route was removed on 2026-09-23, so `resolvePlanProvider` answers `claude` for any
 * policy object, and the ledger fallback therefore never fires.
 */
import { describe, expect, it } from 'vitest';

import { loadPolicy, policyPath, providerFor } from '../../../src/forge/policy.js';
import { planProviderWithLedgerFallback, resolvePlanProvider } from '../../../src/forge/intake/reasoner.js';

describe('the policy file plans on claude', () => {
  it('the real, checked-in policy file plans on claude', () => {
    const policy = loadPolicy(policyPath());
    expect(resolvePlanProvider(policy.reasoner)).toBe('claude');
    expect(providerFor('plan')).toBe('claude');
    expect(providerFor('master')).toBe('claude');
    expect(JSON.stringify(policy)).not.toMatch(/astra/i);
  });
});

describe('resolvePlanProvider', () => {
  it('is claude with a reasoner block', () => {
    expect(resolvePlanProvider({ timeoutMs: 5000 })).toBe('claude');
  });

  it('is claude when the block is missing entirely (an older policy file)', () => {
    expect(resolvePlanProvider(undefined)).toBe('claude');
  });
});

describe('planProviderWithLedgerFallback', () => {
  it('never falls back (and never journals), since claude was the only choice', () => {
    const calls: Array<[string, string]> = [];
    const provider = planProviderWithLedgerFallback(
      { timeoutMs: 5000 }, true, (from, to) => calls.push([from, to]),
    );
    expect(provider).toBe('claude');
    expect(calls).toEqual([]);
  });
});
