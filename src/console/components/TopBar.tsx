import type { JSX } from 'react';
import { useLayoutEffect, useRef } from 'react';

import { hm } from '../freshness.js';
import type { Caps, Feed } from '../../shared/console-model.js';
import { fmtTokens } from '../../shared/format-tokens.js';
import type { State, View } from '../store.js';

import lockup from '../../../brand/flightdeck-lockup-h96.png';

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
  return (
    <div
      ref={barRef}
      style={{
        display: 'flex', alignItems: 'center', gap: '14px 20px', padding: '10px 22px',
        borderBottom: '1px solid var(--line)', background: 'var(--panel)', boxShadow: 'inset 0 1px 0 var(--hi)', flexWrap: 'wrap',
        position: 'relative', zIndex: 1,
      }}
    >
      <img src={lockup} alt="Flightdeck" data-testid="brand-lockup" style={{ height: 28, display: 'block' }} />
      <div style={{ display: 'flex', gap: 16 }}>
        <a className={`nav ${view === 'board' ? 'navOn' : ''}`} onClick={() => onNav('board')}>Board</a>
        <a className={`nav ${view === 'settings' ? 'navOn' : ''}`} onClick={() => onNav('settings')}>
          Settings{settingsBadge > 0 ? <span style={{ color: 'var(--block)' }}> ● {settingsBadge} down</span> : null}
        </a>
        <a className={`nav ${view === 'review' ? 'navOn' : ''}`} onClick={() => onNav('review')}>
          Flight review{reviewBadge > 0 ? <span style={{ color: 'var(--park)' }}> {reviewBadge} proposed</span> : null}
        </a>
        <a className={`nav ${view === 'queue' ? 'navOn' : ''}`} onClick={() => onNav('queue')}>
          Queue{queueBadge > 0 ? <span title="needs attention" style={{ color: 'var(--park)' }}> {queueBadge}</span> : null}
        </a>
        <a className={`nav ${view === 'blockers' ? 'navOn' : ''}`} onClick={() => onNav('blockers')}>
          Blockers{blockersBadge > 0 ? <span style={{ color: 'var(--block)' }}> {blockersBadge}</span> : null}
        </a>
      </div>
      <span style={{ flex: 1 }} />
      {liveCount > 0 ? (
        <span
          data-testid="topbar-live-count" className="m"
          style={{ fontSize: '10.5px', color: 'var(--run)', display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <span className="live-pulse" aria-hidden="true" />
          {liveCount} live
        </span>
      ) : null}
      {oldestPending ? (
        <span data-testid="topbar-working" className="m" style={{ fontSize: '10.5px', color: 'var(--ink2)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="fdSpinner" aria-hidden="true" />
          Working: {oldestPending.label} · {workingSeconds}s
        </span>
      ) : null}
      <span className="m" style={{ fontSize: '10.5px', color: 'var(--ink3)', border: '1px solid var(--line2)', borderRadius: 3, padding: '4px 10px', cursor: 'pointer' }} onClick={onOpenPalette}>
        ⌘K jump
      </span>
      <span className="lbl" style={{ color: 'var(--ink2)' }}>tokens today</span>
      <span
        className={overDaily ? 'w2' : 'w0'}
        style={{ fontSize: 14, padding: '2px 8px' }}
        onClick={onOpenCost}
      >
        {fmtTokens(tokensToday)}{caps && Number.isFinite(caps.dailyTokens) ? ` / ${fmtTokens(caps.dailyTokens)}` : ''}
      </span>
      <span className={feed.live ? 'stF' : 'stO'}>
        {feed.live ? `■ live feed · ${latencyMs}ms` : `○ feed lost ${hm(feed.lostAt ?? now)}`}
      </span>
      <span className="m" style={{ fontSize: 11, color: 'var(--ink2)', minWidth: 62 }}>{hm(now)}</span>
      <span className="chip chipB" title="show raw ids and every row" onClick={onToggleVerbose}>{verbose ? 'verbose' : 'plain'}</span>
      <span className="chip chipB" onClick={onToggleTheme}>{theme === 'thD' ? 'day mode' : 'night ops'}</span>
    </div>
  );
}
