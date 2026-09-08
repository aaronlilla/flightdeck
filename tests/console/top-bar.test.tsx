// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TopBar } from '../../src/console/components/TopBar.js';
import type { Feed } from '../../src/shared/console-model.js';

function feed(extra: Partial<Feed> = {}): Feed {
  return { live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: null, ...extra };
}

function renderBar(overrides: Partial<Parameters<typeof TopBar>[0]> = {}): void {
  render(
    <TopBar
      view="board" settingsBadge={0} reviewBadge={0} queueBadge={0} blockersBadge={0} accountsBadge={0} caps={null} tokensToday={0}
      feed={feed()} now={Date.now()} fetchLatencyMs={null} theme="thD" verbose={false}
      onNav={vi.fn()} onOpenPalette={vi.fn()} onOpenCost={vi.fn()} onToggleTheme={vi.fn()} onToggleVerbose={vi.fn()}
      {...overrides}
    />,
  );
}

// 2026-09-08: the board is plain by default; this chip is the one switch that
// asks every route for the raw, id-carrying rows instead.
describe('TopBar verbose chip', () => {
  it('reads "plain" while off', () => {
    renderBar({ verbose: false });
    expect(screen.getByText('plain')).toBeInTheDocument();
  });

  it('reads "verbose" while on', () => {
    renderBar({ verbose: true });
    expect(screen.getByText('verbose')).toBeInTheDocument();
  });

  it('toggles on click', async () => {
    const onToggleVerbose = vi.fn();
    renderBar({ verbose: false, onToggleVerbose });
    screen.getByText('plain').click();
    expect(onToggleVerbose).toHaveBeenCalledTimes(1);
  });
});

// Row: theme chip labels the mode a click switches TO, not the mode showing now
// (script_wrapped.txt 303: `themeD?'day mode':'night ops'`).
describe('TopBar theme chip', () => {
  it('offers "day mode" while dark', () => {
    renderBar({ theme: 'thD' });
    expect(screen.getByText('day mode')).toBeInTheDocument();
  });

  it('offers "night ops" while light', () => {
    renderBar({ theme: 'thL' });
    expect(screen.getByText('night ops')).toBeInTheDocument();
  });
});

// Row: feed-lost stamp is a glyph plus the absolute lost-at time, not a countdown.
describe('TopBar feed stamp', () => {
  it('renders the glyph and the lost-at time once the feed drops', () => {
    const lostAt = Date.parse('2026-01-01T09:05:00');
    renderBar({ feed: feed({ live: false, lostAt, retryInS: 12 }) });
    expect(screen.getByText(/^○ feed lost \d{2}:\d{2}$/)).toBeInTheDocument();
  });
});

// Row: Settings nav badge uses a filled bullet, and Flight review's badge carries no
// separator dot.
describe('TopBar nav badges', () => {
  it('badges Settings with a bullet glyph', () => {
    renderBar({ settingsBadge: 1 });
    expect(screen.getByText('● 1 down')).toBeInTheDocument();
  });

  it('badges Flight review with the bare count, no leading dot', () => {
    renderBar({ reviewBadge: 3 });
    expect(screen.getByText('3 proposed')).toBeInTheDocument();
  });

  // Sweep #18: the badge's own meaning (parked+failed) was never named anywhere,
  // so it read as a disagreement with the Queue view's own "N items" header.
  it('labels the Queue badge "needs attention" so it explains itself against the header count', () => {
    renderBar({ queueBadge: 8 });
    expect(screen.getByText('8')).toHaveAttribute('title', 'needs attention');
  });
});
