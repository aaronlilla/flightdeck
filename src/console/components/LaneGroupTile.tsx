import type { JSX } from 'react';
import { useState } from 'react';

import { laneCta, plainLine } from '../laneVM.js';
import type { LaneGroup } from '../laneVM.js';
import type { TipSpec } from '../store.js';
import type { Lane } from '../../shared/console-model.js';
import { LaneTile } from './LaneTile.js';

export interface LaneGroupTileProps {
  group: LaneGroup;
  feedLive: boolean;
  now: number;
  onOpen: (id: string) => void;
  onOpenCost: (id: string) => void;
  onCommand: (id: string, cmd: string) => void;
  onTip: (tip: TipSpec | null) => void;
}

/** H2.2: one grid cell per ticket. A single-attempt group renders the plain tile;
 *  a group with more than one attempt adds an "attempt N of M" chip and a
 *  disclosure that lists the earlier attempts underneath, each with its own
 *  plain sentence and CTA -- so a retried ticket never shows as three identical
 *  tiles fighting for the same grid cell. */
export function LaneGroupTile({ group, feedLive, now, onOpen, onOpenCost, onCommand, onTip }: LaneGroupTileProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [newest, ...earlier] = group.lanes as [Lane, ...Lane[]];
  return (
    <div>
      <LaneTile lane={newest} feedLive={feedLive} now={now} onOpen={onOpen} onOpenCost={onOpenCost} onCommand={onCommand} onTip={onTip} />
      {earlier.length > 0 ? (
        <div className="plate" style={{ marginTop: 4, padding: '6px 8px' }}>
          <span
            className="chip chipB"
            data-testid={`group-attempts-${group.key}`}
            onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
          >
            attempt {newest.attempt} of {group.lanes.length}
          </span>
          {open ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
              {earlier.map((l) => {
                const cta = laneCta(l);
                return (
                  <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                    <span className="m" style={{ fontSize: '10.5px', color: 'var(--ink2)' }}>{plainLine(l)}</span>
                    <span className={cta.cls} style={{ padding: '5px 8px', fontSize: 9 }} onClick={() => onCommand(l.id, cta.cmd)}>{cta.label}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
