import type { JSX } from 'react';

import type { View } from '../store.js';
import type { Feed } from '../../shared/console-model.js';
import { hm } from '../freshness.js';
import icon from '../../../brand/flightdeck-icon.png';

/** `FD Chrome.dc.html`: the window strip and the tab bar. Tabs are the design's five in
 *  its order; a badge is a real count (open blockers a person can clear, questions
 *  waiting on the Board) and is absent at zero. */
export interface ChromeProps {
  view: View;
  badges: Partial<Record<View, number>>;
  feed: Feed;
  /** `FORGE_BACKLOG_PROJECT` and its Jira name, off `/state`; absent means the label is
   *  left out rather than a sample project shown. */
  project: { key: string; name: string | null } | null;
  now: number;
  onNav: (view: View) => void;
}

const TABS: { view: View; label: string }[] = [
  { view: 'blockers', label: 'Blockers' },
  { view: 'board', label: 'Board' },
  { view: 'queue', label: 'Queue' },
  { view: 'review', label: 'Review' },
  { view: 'settings', label: 'Settings' },
];

export function Chrome({ view, badges, feed, project, now, onNav }: ChromeProps): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 'none', fontFamily: 'Barlow,system-ui,sans-serif', color: 'var(--ink)', background: 'var(--bg)' }}>
      <div style={{ height: 32, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 0 0 10px', background: 'var(--panel)', borderBottom: '1px solid var(--line)', fontSize: 'var(--fs-meta)', color: 'var(--ink2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src={icon} alt="" style={{ width: 16, height: 16, display: 'block' }} />
          <span>Flightdeck</span>
        </div>
        <div style={{ display: 'flex', height: 32 }}>
          <span style={{ width: 46, display: 'grid', placeItems: 'center', fontSize: 'var(--fs-body)' }}>–</span>
          <span style={{ width: 46, display: 'grid', placeItems: 'center' }}><i style={{ display: 'block', width: 10, height: 10, border: '1px solid currentColor' }} /></span>
          <span style={{ width: 46, display: 'grid', placeItems: 'center', fontSize: 'var(--fs-key)' }}>✕</span>
        </div>
      </div>
      <div style={{ height: 48, display: 'flex', alignItems: 'center', gap: 28, padding: '0 20px', borderBottom: '1px solid var(--line)' }}>
        <span className="hd" style={{ fontSize: 'var(--fs-heading)', letterSpacing: '.06em', textTransform: 'uppercase' }}>Flightdeck</span>
        <nav style={{ display: 'flex', gap: 22, alignItems: 'center', height: 48 }}>
          {TABS.map((tab) => {
            const on = tab.view === view;
            const badge = badges[tab.view];
            return (
              <a
                key={tab.view} href="#" data-testid={`nav-${tab.view}`} aria-current={on ? 'page' : undefined}
                onClick={(e) => { e.preventDefault(); onNav(tab.view); }}
                className="hd"
                style={{
                  fontSize: 'var(--fs-title)', letterSpacing: '.04em', textTransform: 'uppercase', color: on ? 'var(--ink)' : 'var(--ink2)',
                  textDecoration: 'none', height: 48, display: 'flex', alignItems: 'center', borderBottom: `2px solid ${on ? 'var(--acc)' : 'transparent'}`, gap: 6,
                }}
              >
                {tab.label}
                {badge ? (
                  <span style={{ fontFamily: 'Barlow,sans-serif', fontSize: 'var(--fs-kicker)', fontWeight: 700, padding: '1px 6px', background: 'var(--warn)', color: 'var(--warnInk)' }}>{badge}</span>
                ) : null}
              </a>
            );
          })}
        </nav>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, fontSize: 'var(--fs-ui)', color: 'var(--ink2)' }}>
          <span data-testid="feed-state" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <i style={{ width: 8, height: 8, background: feed.live ? 'var(--acc)' : 'var(--warn)', display: 'block' }} />
            {feed.live ? 'Feed live' : `Feed lost${feed.reason ? `: ${feed.reason}` : ''}`}
          </span>
          {project ? <span data-testid="project-label">{project.name ? `${project.key} · ${project.name}` : project.key}</span> : null}
          <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--ink)' }}>{hm(now)}</span>
        </div>
      </div>
    </div>
  );
}
