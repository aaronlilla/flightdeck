import type { JSX } from 'react';

import { capText, costClass } from '../laneVM.js';
import type { Lane } from '../../shared/console-model.js';

export interface CostSheetProps {
  lane: Lane;
  onClose: () => void;
  onKill: (id: string) => void;
}

/** Cost sheet: total readout, tokens, cap state, burn, Kill attempt when over cap. */
export function CostSheet({ lane, onClose, onKill }: CostSheetProps): JSX.Element {
  const over = lane.capUsd !== null && lane.costUsd > lane.capUsd;
  return (
    <div className="plate" data-testid="cost-sheet" style={{ width: 520, maxWidth: 'calc(100vw - 40px)' }}>
      <div className="lbl" style={{ padding: '7px 20px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--line)' }}>
        <span>Cost · {lane.id}</span>
        <span style={{ cursor: 'pointer' }} onClick={onClose}>esc ✕</span>
      </div>
      <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <span className={costClass(lane)}>${lane.costUsd.toFixed(2)}</span>
          <div className="m" style={{ fontSize: 11, lineHeight: 1.8, color: 'var(--ink2)' }}>
            {Math.round(lane.ctxTokens / 1000)}k tokens<br />
            {capText(lane)} · burn ${lane.burnUsdPerMin.toFixed(2)}/min
          </div>
          <span style={{ flex: 1 }} />
          {over ? <span className="btnR" onClick={() => onKill(lane.id)}>Kill attempt</span> : null}
        </div>
      </div>
    </div>
  );
}
