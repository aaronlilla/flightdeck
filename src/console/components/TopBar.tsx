import type { JSX } from 'react';

import { hm } from '../freshness.js';
import type { Caps, Feed } from '../../shared/console-model.js';
import { fmtTokens } from '../../shared/format-tokens.js';
import type { View } from '../store.js';

export interface TopBarProps {
  view: View;
  settingsBadge: number;
  reviewBadge: number;
  queueBadge: number;
  caps: Caps | null;
  tokensToday: number;
  feed: Feed;
  now: number;
  /** Duration of the last `/lanes` fetch, used when no heartbeat has arrived yet. */
  fetchLatencyMs: number | null;
  theme: 'thD' | 'thL';
  onNav: (view: View) => void;
  onOpenPalette: () => void;
  onOpenCost: () => void;
  onToggleTheme: () => void;
}

/** Top nav: Board / Settings [n down] / Flight review [n proposed], ⌘K, spend today, feed stamp, clock, theme. */
export function TopBar(props: TopBarProps): JSX.Element {
  const { view, settingsBadge, reviewBadge, queueBadge, caps, tokensToday, feed, now, fetchLatencyMs, theme, onNav, onOpenPalette, onOpenCost, onToggleTheme } = props;
  const overDaily = caps ? tokensToday > caps.dailyTokens : false;
  // Latency prefers the age of the last heartbeat round trip; before one arrives (or once
  // the feed is driven by polling alone) it falls back to the last `/lanes` fetch duration.
  const latencyMs = feed.lastHeartbeatAt !== null ? Math.max(0, now - feed.lastHeartbeatAt) : (fetchLatencyMs ?? 0);
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: '14px 20px', padding: '10px 22px',
        borderBottom: '1px solid var(--line)', background: 'var(--panel)', boxShadow: 'inset 0 1px 0 var(--hi)', flexWrap: 'wrap',
      }}
    >
      <span className="m" style={{ fontSize: 14, fontWeight: 700, letterSpacing: 6 }}>FLIGHTDECK</span>
      <div style={{ display: 'flex', gap: 16 }}>
        <a className={`nav ${view === 'board' ? 'navOn' : ''}`} onClick={() => onNav('board')}>Board</a>
        <a className={`nav ${view === 'settings' ? 'navOn' : ''}`} onClick={() => onNav('settings')}>
          Settings{settingsBadge > 0 ? <span style={{ color: 'var(--block)' }}> ● {settingsBadge} down</span> : null}
        </a>
        <a className={`nav ${view === 'review' ? 'navOn' : ''}`} onClick={() => onNav('review')}>
          Flight review{reviewBadge > 0 ? <span style={{ color: 'var(--park)' }}> {reviewBadge} proposed</span> : null}
        </a>
        <a className={`nav ${view === 'queue' ? 'navOn' : ''}`} onClick={() => onNav('queue')}>
          Queue{queueBadge > 0 ? <span style={{ color: 'var(--park)' }}> {queueBadge}</span> : null}
        </a>
      </div>
      <span style={{ flex: 1 }} />
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
      <span className="chip chipB" onClick={onToggleTheme}>{theme === 'thD' ? 'day mode' : 'night ops'}</span>
    </div>
  );
}
