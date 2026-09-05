// @vitest-environment jsdom
/**
 * W2: "A field with only `observed_at` (no `verified_at`) renders visibly
 * different from one with both" — the P6.3 truth-auditor requirement.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Freshness } from '../../src/console/components/Freshness.js';

afterEach(cleanup);

describe('Freshness', () => {
  it('marks a field with only observed_at as observed, unverified', () => {
    render(<Freshness observedAt={1000} now={61_000} />);
    const badge = screen.getByTitle('not confirmed against its source since this was recorded');
    expect(badge.dataset['freshness']).toBe('observed');
    expect(badge.textContent).toMatch(/observed only/);
  });

  it('marks a field with verified_at as verified, and the two never share a class', () => {
    render(<Freshness verifiedAt={1000} now={61_000} />);
    const badge = screen.getByTitle('read fresh from its source');
    expect(badge.dataset['freshness']).toBe('verified');
    expect(badge.textContent).toMatch(/^verified/);
    expect(badge.className).not.toContain('freshness--observed');
  });
});
