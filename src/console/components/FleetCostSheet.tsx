import type { JSX } from 'react';

import { capText, costClass } from '../laneVM.js';
import type { Lane } from '../../shared/console-model.js';
import { fmtTokens } from '../../shared/format-tokens.js';

export interface FleetCostSheetProps {
  lanes: Lane[];
  tokensToday: number;
  onClose: () => void;
  onOpenLane: (id: string) => void;
}

/** The fleet-wide cost sheet the top bar's spend readout opens: total spend today,
 *  then one row per lane (id, model, state, cost, cap). */
export function FleetCostSheet({ lanes, tokensToday, onClose, onOpenLane }: FleetCostSheetProps): JSX.Element {
  const sorted = [...lanes].sort((a, b) => b.tokens - a.tokens);
  return (
    <div className="plate" data-testid="fleet-cost-sheet" style={{ width: 640, maxWidth: 'calc(100vw - 40px)' }}>
      <div className="lbl" style={{ padding: '7px 20px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--line)' }}>
        <span>Cost · fleet</span>
        <span style={{ cursor: 'pointer' }} onClick={onClose}>esc ✕</span>
      </div>
      <div style={{ padding: '18px 22px 8px', display: 'flex', alignItems: 'baseline', gap: 14 }}>
        <span className="lbl" style={{ color: 'var(--ink2)' }}>tokens today</span>
        <span className="w0" style={{ fontSize: 22 }}>{fmtTokens(tokensToday)}</span>
      </div>
      <div className="scroll" style={{ maxHeight: 360, overflow: 'auto', padding: '4px 0 12px' }}>
        {sorted.map((lane) => (
          <div
            key={lane.id}
            className="m"
            style={{ display: 'grid', gridTemplateColumns: '110px 90px 1fr 90px 110px', gap: 12, padding: '7px 22px', fontSize: 11, alignItems: 'center', cursor: 'pointer' }}
            onClick={() => onOpenLane(lane.id)}
          >
            <span style={{ fontWeight: 700 }}>{lane.id}</span>
            <span style={{ color: 'var(--ink2)' }}>{lane.model}</span>
            <span style={{ color: 'var(--ink2)' }}>{lane.state}</span>
            <span className={costClass(lane)} style={{ fontSize: 12, padding: '2px 6px' }}>{fmtTokens(lane.tokens)}</span>
            <span style={{ color: 'var(--ink3)', fontSize: '9.5px' }}>{capText(lane)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
