import type { JSX } from 'react';
import { useEffect, useState } from 'react';

import * as api from '../api.js';
import { actionable } from '../keyboard-actionable.js';
import { laneHeadline, stateOf } from '../laneVM.js';
import type { Lane, LaneSandbox, SandboxLogLine, SandboxLogSeverity } from '../../shared/console-model.js';

export interface SandboxSheetProps {
  lane: Lane;
  onClose: () => void;
  onKill: (id: string) => void;
  /** Sweep #9: "Open shell" had no onClick at all. There is no real terminal this
   *  sheet can open into, so it copies the sandbox's own worktree path to the
   *  clipboard instead -- the fastest real thing a click here can do -- and reports
   *  it with a toast. Optional so a caller that has not wired a toast yet still gets
   *  a working sheet, just without the confirmation. */
  onCopiedPath?: (path: string) => void;
}

const SEVERITY_COLOR: Record<SandboxLogSeverity, string> = {
  info: '#9aa08c',
  progress: 'var(--hand)',
  retry: 'var(--park)',
  error: 'var(--block)',
};

/** Sandbox sheet: region/instance/model/state, log tail, Open shell, Kill sandbox. */
export function SandboxSheet({ lane, onClose, onKill, onCopiedPath }: SandboxSheetProps): JSX.Element {
  const [sandbox, setSandbox] = useState<LaneSandbox | null>(lane.sandbox);
  const [log, setLog] = useState<SandboxLogLine[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setLoadFailed(false);
    api.getRunSandbox(lane.id).then((r) => { if (active) { setSandbox(r.sandbox); setLog(r.log); } })
      .catch(() => { if (active) setLoadFailed(true); });
    return () => { active = false; };
  }, [lane.id]);

  const st = stateOf(lane.state);
  return (
    <div className="plate" data-testid="sandbox-sheet" style={{ width: 620, maxWidth: 'calc(100vw - 40px)' }}>
      <div className="lbl" style={{ padding: '7px 20px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--line)' }}>
        <span title={laneHeadline(lane).runId}>Sandbox · {sandbox?.id ?? '--'} · {laneHeadline(lane).main}</span>
        <span style={{ cursor: 'pointer' }} {...actionable(onClose)}>esc ✕</span>
      </div>
      <div style={{ padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="chip">{sandbox?.region ?? '--'}</span>
          <span className="chip">{sandbox?.instanceType ?? '--'}</span>
          <span className="chip">{lane.model}</span>
          <span className="chip" style={{ color: st.color, borderColor: st.color }}>{st.label}</span>
          <span style={{ flex: 1 }} />
          <span
            className="btnS"
            style={{ opacity: sandbox?.path ? 1 : 0.5, cursor: sandbox?.path ? 'pointer' : 'default' }}
            {...actionable(() => {
              if (!sandbox?.path) return;
              void navigator.clipboard?.writeText(sandbox.path).then(() => onCopiedPath?.(sandbox.path as string));
            })}
          >
            Open shell
          </span>
          <span className="btnR" {...actionable(() => onKill(lane.id))}>Kill sandbox</span>
        </div>
        <div style={{ background: 'var(--well)', borderRadius: 3, padding: '12px 14px', boxShadow: 'inset 0 2px 5px rgba(0,0,0,.6)' }}>
          <div className="m" style={{ fontSize: '10.5px', lineHeight: 1.9, color: '#9aa08c' }}>
            {loadFailed
              ? <div style={{ color: 'var(--block)' }}>could not load the sandbox log.</div>
              : (log.length === 0
                ? <div style={{ color: '#59614d' }}>no sandbox log</div>
                : log.map((line, i) => <div key={i} style={{ color: SEVERITY_COLOR[line.severity] }}>{line.text}</div>))}
          </div>
        </div>
      </div>
    </div>
  );
}
