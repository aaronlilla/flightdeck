import type { JSX } from 'react';
import { ACTIONS } from '../actions.js';
import { ActionButton } from './ActionButton.js';
import { useLayoutEffect, useRef } from 'react';

import { hm } from '../freshness.js';
import type { Caps, Feed } from '../../shared/console-model.js';
import { fmtTokens } from '../../shared/format-tokens.js';
import type { State, View } from '../store.js';

import icon from '../../../brand/flightdeck-icon.png';
import lockup from '../../../brand/flightdeck-lockup-h96.png';

/** doctrine/design/FD Chrome.dc.html tab order and labels; the view id behind each stays
 *  the one the store already routes on, so nothing about navigation changes -- only the
 *  word on the tab and where it sits in the row. */
const TABS: ReadonlyArray<{ view: View; label: string }> = [
  { view: 'blockers', label: 'Blockers' },
  { view: 'board', label: 'Board' },
  { view: 'queue', label: 'Queue' },
  { view: 'review', label: 'Review' },
  { view: 'settings', label: 'Settings' },
];

export interface TopBarProps {
  view: View;
  settingsBadge: number;
  reviewBadge: number;
  queueBadge: number;
  blockersBadge: number;
  caps: Caps | null;
  tokensToday: number;
  feed: Feed;
  now: number;
  /** Duration of the last `/lanes` fetch, used when no heartbeat has arrived yet. */
  fetchLatencyMs: number | null;
  theme: 'thD' | 'thL';
  /** 2026-09-08: plain by default -- every route answers human sentences with the
   *  machine ids stripped. This chip is the one switch back to the raw rows. */
  verbose: boolean;
  /** Every action currently in flight, keyed the same way `useAction` keys it.
   *  Empty when nothing is running -- the "Working: ..." line renders nothing then. */
  pending: State['pending'];
  /** How many lanes on the board have a worker answering right now
   *  (`Lane.live.alive`). The pulsing "N live" chip hides entirely at 0, the same
   *  instant the last worker's process actually stops. */
  liveCount: number;
  onNav: (view: View) => void;
  onOpenPalette: () => void;
  onOpenCost: () => void;
  onToggleTheme: () => void;
  onToggleVerbose: () => void;
}

/** Top nav: Board / Settings [n down] / Flight review [n proposed], ⌘K, spend today, feed stamp, clock, theme, verbose. */
export function TopBar(props: TopBarProps): JSX.Element {
  const {
    view, settingsBadge, reviewBadge, queueBadge, blockersBadge, caps, tokensToday, feed, now, fetchLatencyMs, theme,
    verbose, pending, liveCount, onNav, onOpenPalette, onOpenCost, onToggleTheme, onToggleVerbose,
  } = props;
  // More than one action can be in flight at once (a run action plus a background
  // reaudit poll, say) -- the oldest one is shown, on the theory that whatever has
  // been running longest is the one worth knowing about.
  const oldestPending = Object.values(pending).sort((a, b) => a.since - b.since)[0] ?? null;
  const workingSeconds = oldestPending ? Math.max(0, Math.round((now - oldestPending.since) / 1000)) : 0;
  const overDaily = caps ? tokensToday > caps.dailyTokens : false;
  // Latency prefers the age of the last heartbeat round trip; before one arrives (or once
  // the feed is driven by polling alone) it falls back to the last `/lanes` fetch duration.
  const latencyMs = feed.lastHeartbeatAt !== null ? Math.max(0, now - feed.lastHeartbeatAt) : (fetchLatencyMs ?? 0);
  // The bar wraps onto two lines in a narrow window, so its height is measured rather
  // than assumed: every overlay starts at --topbar-h and a sheet's band can never sit
  // behind it (seen live 2026-09-08 in the desktop window).
  const barRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const apply = (): void => { document.documentElement.style.setProperty('--topbar-h', `${el.offsetHeight}px`); };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Every badge keeps the exact glyph and color the board already reads: a filled bullet
  // ahead of Settings, a bare count after Review, a titled count on Queue and Blockers.
  const badges: Record<View, { n: number; node: (n: number) => JSX.Element } | null> = {
    board: null,
    settings: { n: settingsBadge, node: (n) => <span style={{ color: 'var(--block)' }}> ● {n} down</span> },
    review: { n: reviewBadge, node: (n) => <span style={{ color: 'var(--park)' }}> {n} proposed</span> },
    queue: { n: queueBadge, node: (n) => <span title="needs attention" style={{ color: 'var(--park)' }}> {n}</span> },
    blockers: { n: blockersBadge, node: (n) => <span style={{ color: 'var(--block)' }}> {n}</span> },
  };
  return (
    <div ref={barRef} style={{ position: 'relative', zIndex: 1 }}>
      {/* doctrine/design/FD Chrome.dc.html: the 32px window strip -- the app icon and the
          plain word "Flightdeck", above the tab bar rather than folded into it. */}
      <div
        style={{
          height: 32, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px',
          background: 'var(--panel)', borderBottom: '1px solid var(--line)',
          fontSize: 'var(--fs-meta)', color: 'var(--ink2)',
        }}
      >
        <img src={icon} alt="" style={{ width: 16, height: 16, display: 'block' }} />
        <span>Flightdeck</span>
      </div>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: '14px 20px', padding: '0 22px', minHeight: 48,
          borderBottom: '1px solid var(--line)', background: 'var(--panel)', boxShadow: 'inset 0 1px 0 var(--hi)', flexWrap: 'wrap',
        }}
      >
        <img src={lockup} alt="Flightdeck" data-testid="brand-lockup" style={{ height: 28, display: 'block' }} />
        <nav style={{ display: 'flex', gap: 22, alignItems: 'center', height: 48 }}>
          {TABS.map(({ view: tabView, label }) => {
            const badge = badges[tabView];
            const on = view === tabView;
            return (
              <a
                key={tabView}
                onClick={() => onNav(tabView)}
                style={{
                  fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, fontSize: 'var(--fs-title)',
                  letterSpacing: '.04em', textTransform: 'uppercase', color: on ? 'var(--ink)' : 'var(--ink2)',
                  height: 48, display: 'flex', alignItems: 'center',
                  borderBottom: `2px solid ${on ? 'var(--acc)' : 'transparent'}`, textDecoration: 'none', cursor: 'pointer',
                }}
              >
                {label}
                {badge && badge.n > 0 ? badge.node(badge.n) : null}
              </a>
            );
          })}
        </nav>
        <span style={{ flex: 1 }} />
        {liveCount > 0 ? (
          <span
            data-testid="topbar-live-count" className="m"
            style={{ fontSize: 'var(--fs-meta)', color: 'var(--run)', display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <span className="live-pulse" aria-hidden="true" />
            {liveCount} live
          </span>
        ) : null}
        {oldestPending ? (
          <span data-testid="topbar-working" className="m" style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink2)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="fdSpinner" aria-hidden="true" />
            Working: {oldestPending.label} · {workingSeconds}s
          </span>
        ) : null}
        <span className="m" style={{ fontSize: 'var(--fs-ui)', color: 'var(--ink3)', border: '1px solid var(--line2)', borderRadius: 0, padding: '4px 10px', cursor: 'pointer' }} onClick={onOpenPalette}>
          ⌘K jump
        </span>
        <span className="lbl" style={{ color: 'var(--ink2)' }}>tokens today</span>
        <span
          className={overDaily ? 'w2' : 'w0'}
          style={{ fontSize: 'var(--fs-body)', padding: '2px 8px' }}
          onClick={onOpenCost}
        >
          {fmtTokens(tokensToday)}{caps && Number.isFinite(caps.dailyTokens) ? ` / ${fmtTokens(caps.dailyTokens)}` : ''}
        </span>
        <span
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-ui)', color: 'var(--ink2)' }}
          className={feed.live ? 'stF' : 'stO'}
        >
          {feed.live ? (
            <><i aria-hidden="true" style={{ width: 8, height: 8, background: 'var(--acc)', display: 'block' }} />{`Feed live · ${latencyMs}ms`}</>
          ) : `○ feed lost ${hm(feed.lostAt ?? now)}`}
        </span>
        <span style={{ fontSize: 'var(--fs-ui)', color: 'var(--ink2)' }}>Flightdeck</span>
        <span className="m" style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink2)', minWidth: 62 }}>{hm(now)}</span>
        <ActionButton spec={ACTIONS.stopAll} args={[]} actionRef="topbar" className="btnR" style={{ padding: '5px 10px', fontSize: 'var(--fs-ui)' }} busy="Stopping…">Stop all</ActionButton>
        <span className="chip chipB" title="show raw ids and every row" onClick={onToggleVerbose}>{verbose ? 'verbose' : 'plain'}</span>
        <span className="chip chipB" onClick={onToggleTheme}>{theme === 'thD' ? 'day mode' : 'night ops'}</span>
      </div>
    </div>
  );
}
