import type { JSX } from 'react';

export interface QueueOffBannerProps {
  queueOn: boolean;
}

/** D2.4: the web console's own copy of the desktop status window's queue banner
 *  (`desktop/electron/status-page.ts`'s `#queue-banner`) -- same text, same banner
 *  family as `DisconnectedBanner` (a full-width `.lbl` bar right at the top of the
 *  app), reading `/state`'s own `queue_on` flag rather than a separate check. */
export function QueueOffBanner({ queueOn }: QueueOffBannerProps): JSX.Element | null {
  if (queueOn) return null;
  return (
    <div
      className="lbl"
      style={{
        background: 'var(--park)', color: 'var(--aInk)', padding: '8px 22px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}
    >
      <span>Queue is off — set FORGE_QUEUE=1 in Settings to hand it work from the board.</span>
    </div>
  );
}
