/**
 * Requirement 6, as narrowed by the 16:40 amendment: the planner's default provider is
 * `claude` (Sonnet through the Reasoner's `plan` seam); astra is reachable only when the
 * policy file's `reasoner.astra` flag is `planning-only`, and the flag ships `off`. No
 * stream build, test, lens or review calls astra — this file never constructs a real
 * Codex client; `resolvePlanProvider` is pure and only ever reads a policy object.
 */
import { describe, expect, it } from 'vitest';

import { loadPolicy, policyPath } from '../../../src/forge/policy.js';
import { planProviderWithLedgerFallback, resolvePlanProvider } from '../../../src/forge/intake/reasoner.js';

describe('the policy file ships the astra flag off', () => {
  it('reasoner.astra is "off" in the real, checked-in policy file', () => {
    expect(loadPolicy(policyPath()).reasoner?.astra ?? 'off').toBe('off');
  });
});

describe('resolvePlanProvider', () => {
  it('defaults to claude when the flag is off', () => {
    expect(resolvePlanProvider({ astra: 'off' })).toBe('claude');
  });

  it('defaults to claude when the flag is missing entirely (an older policy file)', () => {
    expect(resolvePlanProvider(undefined)).toBe('claude');
  });

  it('is reachable on codex only when the flag is exactly "planning-only"', () => {
    expect(resolvePlanProvider({ astra: 'planning-only' })).toBe('codex');
  });

  it('treats any other value as off — astra is opt-in, not opt-out', () => {
    expect(resolvePlanProvider({ astra: 'always' as never })).toBe('claude');
  });
});

describe('planProviderWithLedgerFallback', () => {
  it('falls back to claude and journals it when astra is wanted but the ledger cap is reached', () => {
    const calls: Array<[string, string]> = [];
    const provider = planProviderWithLedgerFallback(
      { astra: 'planning-only' }, true, (from, to) => calls.push([from, to]),
    );
    expect(provider).toBe('claude');
    expect(calls).toEqual([['codex', 'claude']]);
  });

  it('never falls back (and never journals) when astra was never wanted in the first place', () => {
    const calls: Array<[string, string]> = [];
    const provider = planProviderWithLedgerFallback(
      { astra: 'off' }, true, (from, to) => calls.push([from, to]),
    );
    expect(provider).toBe('claude');
    expect(calls).toEqual([]);
  });
});
