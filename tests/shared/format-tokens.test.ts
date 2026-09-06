import { describe, expect, it } from 'vitest';

import { fmtTokens } from '../../src/shared/format-tokens.js';

describe('fmtTokens', () => {
  it('renders a raw count under 1000 as-is', () => {
    expect(fmtTokens(842)).toBe('842');
  });

  it('renders thousands compact with a k suffix, one decimal when under 10k', () => {
    expect(fmtTokens(12_400)).toBe('12.4k');
    expect(fmtTokens(847_000)).toBe('847k');
  });

  it('renders millions compact with an M suffix', () => {
    expect(fmtTokens(1_200_000)).toBe('1.2M');
    expect(fmtTokens(15_000_000)).toBe('15M');
  });

  it('never shows a dollar sign or decimal point beyond one digit', () => {
    expect(fmtTokens(1_234_567)).not.toMatch(/\$/);
    expect(fmtTokens(1_234_567)).toBe('1.2M');
  });

  it('treats zero and negative as the raw number', () => {
    expect(fmtTokens(0)).toBe('0');
  });
});
