import { describe, expect, it } from 'vitest';

import { trapTab } from '../../src/console/focus-trap.js';

function ring(n: number): HTMLElement[] {
  return Array.from({ length: n }, () => ({}) as unknown as HTMLElement);
}

describe('trapTab', () => {
  it('wraps Tab from the last element back to the first', () => {
    const r = ring(3);
    expect(trapTab(r, r[2], false)).toBe(r[0]);
  });

  it('wraps Shift+Tab from the first element back to the last', () => {
    const r = ring(3);
    expect(trapTab(r, r[0], true)).toBe(r[2]);
  });

  it('does nothing in the middle of the ring -- the default Tab order already holds', () => {
    const r = ring(3);
    expect(trapTab(r, r[1], false)).toBeNull();
    expect(trapTab(r, r[1], true)).toBeNull();
  });

  it('wraps to the first element when focus is not tracked in the ring at all', () => {
    const r = ring(2);
    expect(trapTab(r, {} as unknown as HTMLElement, false)).toBe(r[0]);
  });

  it('answers null for an empty ring -- nothing to trap', () => {
    expect(trapTab([], null, false)).toBeNull();
  });
});
