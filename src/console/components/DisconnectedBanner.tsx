import type { JSX } from 'react';
export interface DisconnectedBannerProps {
  visible: boolean;
}

export function DisconnectedBanner({ visible }: DisconnectedBannerProps): JSX.Element | null {
  if (!visible) return null;
  return (
    <div className="disconnected-banner" role="status">
      Lost the connection to the fleet server. Retrying, and falling back to a poll every 5 seconds.
    </div>
  );
}
