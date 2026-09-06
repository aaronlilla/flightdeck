import type { JSX } from 'react';
import { useEffect, useState } from 'react';

import * as api from '../api.js';
import { stateOf } from '../laneVM.js';
import type { Lane, LaneSandbox } from '../../shared/console-model.js';

export interface SandboxSheetProps {
  lane: Lane;
  onClose: () => void;
  onKill: (id: string) => void;
}

/** Sandbox sheet: region/instance/model/state, log tail, Open shell, Kill sandbox. */
export function SandboxSheet({ lane, onClose, onKill }: SandboxSheetProps): JSX.Element {
  const [sandbox, setSandbox] = useState<LaneSandbox | null>(lane.sandbox);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    api.getRunSandbox(lane.id).then((r) => { if (active) { setSandbox(r.sandbox); setLog(r.log); } }).catch(() => undefined);
    return () => { active = false; };
  }, [lane.id]);

  const st = stateOf(lane.state);
  return (
    <div className="plate" data-testid="sandbox-sheet" style={{ width: 620, maxWidth: 'calc(100vw - 40px)' }}>
      <div className="lbl" style={{ padding: '7px 20px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--line)' }}>
        <span>Sandbox · {sandbox?.id ?? '--'} · {lane.id}</span>
        <span style={{ cursor: 'pointer' }} onClick={onClose}>esc ✕</span>
      </div>
      <div style={{ padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="chip">{lane.model}</span>
          <span className="chip" style={{ color: st.color, borderColor: st.color }}>{st.label}</span>
          <span style={{ flex: 1 }} />
          <span className="btnS">Open shell</span>
          <span className="btnR" onClick={() => onKill(lane.id)}>Kill sandbox</span>
        </div>
        <div style={{ background: 'var(--well)', borderRadius: 3, padding: '12px 14px', boxShadow: 'inset 0 2px 5px rgba(0,0,0,.6)' }}>
          <div className="m" style={{ fontSize: '10.5px', lineHeight: 1.9, color: '#9aa08c' }}>
            {log.length === 0 ? <div style={{ color: '#59614d' }}>no sandbox log</div> : log.map((line, i) => <div key={i}>{line}</div>)}
          </div>
        </div>
      </div>
    </div>
  );
}
