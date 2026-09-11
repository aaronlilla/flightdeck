// @vitest-environment jsdom
/**
 * The header's watcher line (R-71): renders `watcherLine`, ticks its own countdown
 * every second under a real interval, clears that interval on unmount, and the
 * on/off control calls the toggle exactly once per click.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WatcherStatus } from '../../src/console/components/WatcherStatus.js';
import type { WatcherStatus as WatcherStatusModel } from '../../src/console/sync-types.js';

function status(extra: Partial<WatcherStatusModel> = {}): WatcherStatusModel {
  return { on: true, project: 'BBZ', pollSeconds: 30, lastPollAt: Date.now(), lastCount: 3, ...extra };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('WatcherStatus', () => {
  it('renders the on line', () => {
    render(<WatcherStatus status={status()} onToggle={vi.fn()} />);
    expect(screen.getByTestId('watcher-line').textContent).toMatch(/^Watching BBZ/);
  });

  it('renders the off line', () => {
    render(<WatcherStatus status={status({ on: false })} onToggle={vi.fn()} />);
    expect(screen.getByTestId('watcher-line').textContent).toBe('Watcher off');
  });

  it('renders the error line', () => {
    render(<WatcherStatus status={status({ lastError: 'Jira: 401 Unauthorized' })} onToggle={vi.fn()} />);
    expect(screen.getByTestId('watcher-line').textContent).toBe('Watcher error: Jira: 401 Unauthorized');
  });

  it('counts the countdown down across a fake-timer tick', () => {
    render(<WatcherStatus status={status({ lastPollAt: Date.now(), pollSeconds: 30 })} onToggle={vi.fn()} />);
    const before = screen.getByTestId('watcher-line').textContent;
    act(() => { vi.advanceTimersByTime(3000); });
    const after = screen.getByTestId('watcher-line').textContent;
    expect(after).not.toBe(before);
    const beforeSeconds = Number(/next in (\d+) s/.exec(before ?? '')?.[1]);
    const afterSeconds = Number(/next in (\d+) s/.exec(after ?? '')?.[1]);
    expect(afterSeconds).toBeLessThan(beforeSeconds);
  });

  it('clears its interval on unmount', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = render(<WatcherStatus status={status()} onToggle={vi.fn()} />);
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });

  it('calls the toggle once when clicking off', () => {
    const onToggle = vi.fn();
    render(<WatcherStatus status={status({ on: true })} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('watcher-toggle'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(false);
  });
});
