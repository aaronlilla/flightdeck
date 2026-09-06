import type { JSX } from 'react';

import type { TipSpec } from '../store.js';

export interface HoverCardProps {
  tip: TipSpec | null;
}

/** The 250px dark-well hover card: head, body, "click → target". */
export function HoverCard({ tip }: HoverCardProps): JSX.Element | null {
  if (!tip) return null;
  return (
    <div className="tip" style={{ left: tip.x, top: tip.y }}>
      <div style={{ fontWeight: 600, color: tip.color ?? '#9df598', marginBottom: 2 }}>{tip.head}</div>
      {tip.body}
      {tip.click ? <div style={{ color: '#8d9680', marginTop: 3 }}>{tip.click}</div> : null}
    </div>
  );
}
