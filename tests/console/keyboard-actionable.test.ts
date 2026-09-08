import { describe, expect, it, vi } from 'vitest';

import { actionable } from '../../src/console/keyboard-actionable.js';

function key(k: string): { key: string; preventDefault: () => void } {
  return { key: k, preventDefault: vi.fn() };
}

describe('actionable', () => {
  it('carries button semantics: role=button, tabIndex=0', () => {
    const a = actionable(() => undefined);
    expect(a.role).toBe('button');
    expect(a.tabIndex).toBe(0);
  });

  it('fires onClick on Enter, and prevents the default', () => {
    const onClick = vi.fn();
    const a = actionable(onClick);
    const e = key('Enter');
    a.onKeyDown(e as never);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('fires onClick on Space, and prevents the default', () => {
    const onClick = vi.fn();
    const a = actionable(onClick);
    const e = key(' ');
    a.onKeyDown(e as never);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('ignores every other key', () => {
    const onClick = vi.fn();
    const a = actionable(onClick);
    a.onKeyDown(key('Tab') as never);
    a.onKeyDown(key('a') as never);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('onClick itself is the same handler passed in', () => {
    const onClick = vi.fn();
    const a = actionable(onClick);
    a.onClick();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
