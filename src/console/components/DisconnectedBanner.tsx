import type { JSX } from 'react';

import { hm } from '../freshness.js';
import type { Feed } from '../../shared/console-model.js';

export interface DisconnectedBannerProps {
  feed: Feed;
  onRetry: () => void;
}

/** The red top banner: `⚠ live feed lost {when} · all values last-observed`. */
export function DisconnectedBanner({ feed, onRetry }: DisconnectedBannerProps): JSX.Element | null {
  if (feed.live) return null;
  return (
    <div
      className="lbl"
      style={{
        background: 'var(--block)', color: 'var(--aInk)', padding: '8px 22px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}
    >
      <span>⚠ live feed lost {feed.lostAt ? hm(feed.lostAt) : ''} · all values last-observed{feed.reason ? ` (${feed.reason})` : ''}</span>
      <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {feed.retryInS !== null ? <span>retry in {feed.retryInS}s</span> : null}
        <span
          className="btnS"
          style={{ padding: '4px 10px', color: 'var(--aInk)', borderColor: 'var(--aInk)' }}
          onClick={onRetry}
        >
          Retry now
        </span>
      </span>
    </div>
  );
}
