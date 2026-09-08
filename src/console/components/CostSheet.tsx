import type { JSX } from 'react';
import { LaneCta } from './LaneCta.js';
import { useEffect, useState } from 'react';

import * as api from '../api.js';
import { actionable } from '../keyboard-actionable.js';
import { capText, costClass, laneHeadline } from '../laneVM.js';
import { hm } from '../freshness.js';
import type { CostStep, Lane } from '../../shared/console-model.js';
import { fmtTokens } from '../../shared/format-tokens.js';

export interface CostSheetProps {
  lane: Lane;
  onClose: () => void;
}

/** Cost sheet: total readout, tokens, cap state, burn, by-step breakdown, Kill attempt
 *  when over cap. */
export function CostSheet({ lane, onClose }: CostSheetProps): JSX.Element {
  const [steps, setSteps] = useState<CostStep[]>([]);
  const [capEnforcementFailedJid, setCapEnforcementFailedJid] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setLoadFailed(false);
    api.getRunCost(lane.id).then((r) => {
      if (!active) return;
      setSteps(r.steps);
      setCapEnforcementFailedJid(r.capEnforcementFailedJid);
    }).catch(() => { if (active) setLoadFailed(true); });
    return () => { active = false; };
  }, [lane.id]);

  const over = lane.tokenCap !== null && lane.tokens > lane.tokenCap;
  const totalInput = steps.reduce((sum, s) => sum + s.inputTokens, 0);
  const totalOutput = steps.reduce((sum, s) => sum + s.outputTokens, 0);
  const burnText = lane.state === 'running' ? `${fmtTokens(lane.tokensPerMin)} tokens/min` : '—/min';

  return (
    <div className="plate" data-testid="cost-sheet" style={{ width: 'min(820px, calc(100vw - 48px))', minWidth: 'min(520px, calc(100vw - 48px))', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto', boxSizing: 'border-box' }}>
      <div className="lbl" style={{ padding: '7px 20px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--line)' }}>
        <span title={laneHeadline(lane).runId}>Cost · {laneHeadline(lane).main}</span>
        <span style={{ cursor: 'pointer' }} {...actionable(onClose)}>esc ✕</span>
      </div>
      <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          {/* The one place the board shows the exact count: everywhere else renders
              compact (`fmtTokens`), but the cost sheet's whole purpose is a precise
              number to audit against. */}
          <span className={costClass(lane)}>{lane.tokens.toLocaleString()} tokens</span>
          <div className="m" style={{ fontSize: 11, lineHeight: 1.8, color: 'var(--ink2)' }}>
            {Math.round(totalInput / 1000)}k input · {Math.round(totalOutput / 1000)}k output · {lane.model}<br />
            {capText(lane)}{capEnforcementFailedJid ? ` · cap event failed (${capEnforcementFailedJid})` : ''} · burn {burnText}
          </div>
          <span style={{ flex: 1 }} />
          {over ? <LaneCta lane={lane} cmd="kill" label="Kill attempt" cls="btnR" onCommand={() => undefined} /> : null}
        </div>
        {loadFailed ? (
          <div className="m" style={{ fontSize: 11, color: 'var(--block)' }}>could not load the step breakdown.</div>
        ) : null}
        {!loadFailed && steps.length > 0 ? (
          <div>
            <div className="lbl" style={{ color: 'var(--ink2)', marginBottom: 8 }}>By step</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {steps.map((step, i) => (
                <div key={i} className="m" style={{ fontSize: '10.5px', color: 'var(--ink2)', display: 'flex', gap: 10, alignItems: 'baseline' }}>
                  <span style={{ color: 'var(--ink3)', whiteSpace: 'nowrap' }}>{hm(step.t)}</span>
                  <span style={{ flex: 1 }}>{step.stepText}</span>
                  <span style={{ whiteSpace: 'nowrap' }}>{Math.round(step.inputTokens / 1000)}k in</span>
                  <span style={{ whiteSpace: 'nowrap' }}>{step.tokens.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
