/**
 * `intake/tier.ts`: the deterministic half of complexity routing (opt/tier). The
 * planner's own rubric call is a prompt, and prompts are not tested here -- this file
 * proves the code side: parsing whatever tier a brief reports, the money/auth guardrail
 * that never lets `light` reach Haiku on a money or auth ticket, the fallback to
 * `standard` for anything missing or invalid, and the brief-writing that never skips.
 */
import { describe, expect, it } from 'vitest';

import {
  decideTier, ensureTierLine, matchedGuardrailKeyword, MONEY_AUTH_KEYWORDS, parseTierLine,
  withTierLine,
} from '../../../src/forge/intake/tier.ts';

describe('parseTierLine', () => {
  it('reads a tier and its reason off two separate lines', () => {
    const parsed = parseTierLine('# Goal\n\ntier: light\ntier-reason: one file, copy only\n\nbody\n');
    expect(parsed).toEqual({ tier: 'light', reason: 'one file, copy only' });
  });

  it('reads a tier with no reason line', () => {
    expect(parseTierLine('tier: hard\n')).toEqual({ tier: 'hard' });
  });

  it('returns null for a brief with no tier line at all', () => {
    expect(parseTierLine('# Goal\n\nordinary prose\n')).toBeNull();
  });

  it('does not read an argument about a tier as a decision', () => {
    expect(parseTierLine('The tier: light question is discussed below in this sentence.')).toBeNull();
  });
});

describe('matchedGuardrailKeyword', () => {
  it('matches every declared keyword as a whole word', () => {
    for (const word of MONEY_AUTH_KEYWORDS) {
      expect(matchedGuardrailKeyword(`Fix the ${word} screen`), word).toBe(word);
    }
  });

  it('is case-insensitive', () => {
    expect(matchedGuardrailKeyword('Update the WALLET balance display')).toBe('wallet');
  });

  it('does not fire on a word that merely contains a keyword', () => {
    expect(matchedGuardrailKeyword('Buy a new cardigan for the mascot')).toBeUndefined();
  });

  it('finds nothing in ordinary copy/config text', () => {
    expect(matchedGuardrailKeyword('Fix the typo in the footer copyright text')).toBeUndefined();
  });
});

describe('decideTier: the rubric parse plus the deterministic guardrail', () => {
  it('keeps light when the ticket carries no money/auth keyword', () => {
    const decision = decideTier({ reportedTier: 'light', reason: 'one-line copy fix', text: 'Fix the typo in the footer' });
    expect(decision).toEqual({ tier: 'light', reason: 'one-line copy fix' });
  });

  it('upgrades light to standard the moment a money/auth keyword appears', () => {
    const decision = decideTier({ reportedTier: 'light', reason: 'looked simple', text: 'Reset the withdraw limit for a user' });
    expect(decision.tier).toBe('standard');
    expect(decision.reason).toContain('guardrail');
    expect(decision.reason).toContain('withdraw');
  });

  it('never touches standard or hard even when the guardrail keyword is present', () => {
    expect(decideTier({ reportedTier: 'standard', text: 'touches the wallet balance' }).tier).toBe('standard');
    expect(decideTier({ reportedTier: 'hard', text: 'touches the wallet balance' }).tier).toBe('hard');
  });

  it('defaults a missing tier to standard, never skipping routing', () => {
    const decision = decideTier({ reportedTier: undefined, text: 'anything at all' });
    expect(decision.tier).toBe('standard');
    expect(decision.reason).toMatch(/default/i);
  });

  it('defaults an invalid tier (something the rubric never emits) to standard', () => {
    const decision = decideTier({ reportedTier: 'gigantic', text: 'anything' });
    expect(decision.tier).toBe('standard');
  });

  it('is case-insensitive on the reported tier', () => {
    expect(decideTier({ reportedTier: 'HARD', text: 'x' }).tier).toBe('hard');
  });
});

describe('withTierLine: writing the decision into the brief', () => {
  it('inserts a fresh tier line right under the first heading', () => {
    const text = withTierLine('# Goal: fix the thing\n\nSome body text.\n', 'standard', 'looked ordinary');
    expect(text).toContain('# Goal: fix the thing');
    expect(text).toContain('tier: standard');
    expect(text).toContain('tier-reason: looked ordinary');
    // The tier line lands before the body, not appended after it.
    expect(text.indexOf('tier: standard')).toBeLessThan(text.indexOf('Some body text.'));
  });

  it('inserts at the top for a brief with no heading', () => {
    const text = withTierLine('Some body text with no heading.\n', 'light', 'trivial');
    expect(text.indexOf('tier: light')).toBeLessThan(text.indexOf('Some body text'));
  });

  it('replaces an existing tier line in place rather than duplicating it', () => {
    const original = '# Goal\n\ntier: light\ntier-reason: first guess\n\nbody\n';
    const text = withTierLine(original, 'standard', 'guardrail: "wallet" upgraded light to standard');
    expect(text.match(/^tier:/gm)?.length).toBe(1);
    expect(text).toContain('tier: standard');
    expect(text).toContain('guardrail: "wallet"');
    expect(text).not.toContain('tier: light');
  });
});

describe('ensureTierLine: the one call the planner uses, never skipping', () => {
  it('a brief the model already tagged "light" with no money keyword stays light', () => {
    const { text, decision } = ensureTierLine('# Goal: fix a typo\n\ntier: light\ntier-reason: one file\n\nbody\n');
    expect(decision.tier).toBe('light');
    expect(text).toContain('tier: light');
  });

  it('a brief tagged "light" that mentions payment is upgraded to standard in the written text', () => {
    const { text, decision } = ensureTierLine('# Goal: fix payment retry\n\ntier: light\ntier-reason: looked simple\n\nbody\n');
    expect(decision.tier).toBe('standard');
    expect(text).toContain('tier: standard');
    expect(text).not.toMatch(/^tier: light$/m);
  });

  it('a brief with no tier line at all still gets one -- standard, never skipped', () => {
    const { text, decision } = ensureTierLine('# Goal: some ordinary ticket\n\nno rubric ever ran on this one\n');
    expect(decision.tier).toBe('standard');
    expect(text).toContain('tier: standard');
  });
});
