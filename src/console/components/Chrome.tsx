import type { JSX } from 'react';

import { ACTIONS, useAction } from '../actions.js';
import { WatcherStatus as WatcherStatusRow } from './WatcherStatus.js';
import type { View } from '../store.js';
import type { WatcherStatus as WatcherStatusModel } from '../../shared/sync-contract.js';
import type { Feed } from '../../shared/console-model.js';
import { hm } from '../freshness.js';
import icon from '../../../brand/flightdeck-icon.png';

/** The Full re-sync button (R-71): confirm-gated through the same `useAction` machinery
 *  every other irreversible action uses. First click posts without a token and shows the
 *  server's own blast text; a second, explicit click sends the token back. */
function FullResyncButton({ running }: { running: boolean }): JSX.Element {
  const action = useAction(ACTIONS.fullResync);
  const confirming = action.result?.kind === 'confirm';
  const disabled = action.pending || running;
  const onClick = (): void => {
    if (confirming) void action.confirm();
    else void action.run();
  };
  // The blast can run past 100 characters (queue count, worker count, worktree count),
  // and this row has no room to grow: everything after it (project label, watcher,
  // the button itself, the clock) used to get pushed off the right edge of the window,
  // taking the Confirm button with it -- clicking the first time left nothing left to
  // click. Same `maxWidth` + ellipsis treatment `feed-state`/`project-label` already use
  // above, plus a `title` so the full sentence is still readable on hover.
  const label = action.pending ? (confirming ? 'Starting…' : 'Checking…') : (confirming ? 'Confirm' : 'Full re-sync and start');
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      {confirming ? (
        <span
          data-testid="full-resync-gate"
          title={(action.result as { kind: 'confirm'; blast: string }).blast}
          style={{ minWidth: 0, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {(action.result as { kind: 'confirm'; blast: string }).blast}
        </span>
      ) : null}
      <button
        type="button"
        data-testid={confirming ? 'full-resync-confirm' : 'full-resync'}
        onClick={onClick}
        disabled={disabled}
        title={running ? 'a full re-sync is already running' : undefined}
        style={{ flex: 'none', font: 'inherit', color: 'inherit', background: 'none', border: '1px solid var(--line)', padding: '1px 6px', cursor: disabled ? 'default' : 'pointer' }}
      >
        {label}
      </button>
      {!confirming && action.result?.kind === 'done' ? <span data-testid="full-resync-result">{action.result.text}</span> : null}
    </span>
  );
}

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
  /** `/state`'s `queue_on`: false means the queue subsystem is not running at all, so
   *  nothing starts however many slots are free. Shown beside the feed state. */
  queueOn?: boolean;
  /** R-71: true while the `full` sync scope is `running`, off the `sync` slice. Disables
   *  the Full re-sync button rather than letting a second run race the first. */
  syncFullRunning?: boolean;
  /** R-71: the header's watcher line, off the `sync` slice's `watcher` field. `null`
   *  before the first `/sync` fetch lands -- the row is left out rather than guessed. */
  watcher?: WatcherStatusModel | null;
  onWatcherToggle?: (on: boolean) => void;
  now: number;
  onNav: (view: View) => void;
  /** R-75 item 3: the Needs-you strip, rendered above the tab bar on every view (spec
   *  `doctrine/design/operator-experience.md` §5). A render slot rather than the data,
   *  so the chrome stays ignorant of what needs a person. */
  strip?: JSX.Element;
}

const TABS: { view: View; label: string }[] = [
  { view: 'blockers', label: 'Blockers' },
  { view: 'board', label: 'Board' },
  { view: 'queue', label: 'Queue' },
  { view: 'review', label: 'Review' },
  { view: 'machine', label: 'Machine' },
  { view: 'settings', label: 'Settings' },
];

export function Chrome({ view, badges, feed, project, queueOn = true, syncFullRunning = false, watcher = null, onWatcherToggle, now, onNav, strip }: ChromeProps): JSX.Element {
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
      {strip ?? null}
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
        <div style={{ marginLeft: 'auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: 14, fontSize: 'var(--fs-ui)', color: 'var(--ink2)', whiteSpace: 'nowrap' }}>
          <span data-testid="feed-state" title={feed.reason ?? undefined} style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <i style={{ width: 8, height: 8, background: feed.live ? 'var(--acc)' : 'var(--warn)', display: 'block' }} />
            {feed.live ? 'Feed live' : `Feed lost${feed.reason ? `: ${feed.reason}` : ''}`}
          </span>
          {!queueOn ? <span data-testid="queue-off" style={{ color: 'var(--warn)' }}>Queue off</span> : null}
          {project ? <span data-testid="project-label" title={project.name ?? project.key} style={{ minWidth: 0, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>{project.name ? `${project.key} · ${project.name}` : project.key}</span> : null}
          {watcher ? <WatcherStatusRow status={watcher} onToggle={onWatcherToggle ?? (() => undefined)} /> : null}
          <FullResyncButton running={syncFullRunning} />
          <span style={{ flex: 'none', fontVariantNumeric: 'tabular-nums', color: 'var(--ink)' }}>{hm(now)}</span>
        </div>
      </div>
    </div>
  );
}
