import type { JSX } from 'react';
import { useState } from 'react';

import type { ProposalsResponse, Rule } from '../../shared/console-model.js';

export interface FlightReviewProps {
  proposals: ProposalsResponse | null;
  onApply: (id: string) => void;
  onDismiss: (id: string) => void;
  onRestore: (id: string) => void;
  onUndo: (jid: string) => void;
}

function RuleCard({ rule, onApply, onDismiss, onRestore, onUndo }: {
  rule: Rule; onApply: (id: string) => void; onDismiss: (id: string) => void; onRestore: (id: string) => void; onUndo: (jid: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="plate" style={{ display: 'grid', gridTemplateColumns: '1fr 250px', gap: 20, padding: '16px 18px' }}>
      <div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <span className="chip">{rule.kind}</span>
          <span className="m" style={{ fontSize: 13, fontWeight: 700 }}>{rule.title}</span>
        </div>
        <div className="m" style={{ fontSize: 11, color: 'var(--ink2)' }}>
          {rule.summary} · <a onClick={() => setExpanded((v) => !v)}>{expanded ? 'hide' : 'evidence'}</a>
        </div>
        {expanded ? (
          <div className="m" style={{ fontSize: 11, lineHeight: 1.9, color: 'var(--ink2)', marginTop: 8, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <b style={{ color: 'var(--ink)' }}>evidence</b> {rule.evidence}<br />
            <b style={{ color: 'var(--ink)' }}>effect</b> {rule.effect}
          </div>
        ) : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, justifyContent: 'center' }}>
        {rule.status === 'open' ? (
          <>
            <span className="btnP" style={{ padding: 11 }} onClick={() => onApply(rule.id)}>Apply rule →</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <span className="btnS" style={{ flex: 1 }} onClick={() => setExpanded(true)}>Evidence</span>
              <span className="btnS" style={{ flex: 1 }} onClick={() => onDismiss(rule.id)}>Dismiss</span>
            </div>
          </>
        ) : null}
        {rule.status === 'applied' ? (
          <>
            <span className="m" style={{ fontSize: 11, color: 'var(--run)', textAlign: 'center' }}>✓ applied · {rule.jid}</span>
            <span className="btnS" onClick={() => rule.jid && onUndo(rule.jid)}>Undo</span>
          </>
        ) : null}
        {rule.status === 'dismissed' ? (
          <>
            <span className="m" style={{ fontSize: 11, color: 'var(--ink3)', textAlign: 'center' }}>dismissed</span>
            <span className="btnS" onClick={() => onRestore(rule.id)}>Restore</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Flight review: metrics tiles + Conductor proposals, each Apply/Evidence/Dismiss. */
export function FlightReview({ proposals, onApply, onDismiss, onRestore, onUndo }: FlightReviewProps): JSX.Element {
  const metrics = proposals?.metrics;
  const rules = proposals?.rules ?? [];
  return (
    <div className="scroll" data-testid="review-view" style={{ flex: 1, padding: '28px 36px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderBottom: '2px solid var(--line2)', paddingBottom: 12, marginBottom: 22 }}>
        <span className="lbl">Flight review</span>
        <span className="m" style={{ fontSize: 11, color: 'var(--ink2)' }}>{rules.length} proposals · applied rules get a journal id + undo</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 22 }}>
        <div className="plate" style={{ padding: '12px 14px' }}><div className="lbl" style={{ color: 'var(--ink2)' }}>merged today</div><div className="m" style={{ fontSize: 22, fontWeight: 700, marginTop: 4, color: 'var(--run)' }}>{metrics?.mergedToday ?? 0}</div></div>
        <div className="plate" style={{ padding: '12px 14px' }}><div className="lbl" style={{ color: 'var(--ink2)' }}>human wait</div><div className="m" style={{ fontSize: 22, fontWeight: 700, marginTop: 4, color: 'var(--park)' }}>{metrics?.humanWaitMin ?? 0}m</div></div>
        <div className="plate" style={{ padding: '12px 14px' }}><div className="lbl" style={{ color: 'var(--ink2)' }}>cost / merge</div><div className="m" style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{metrics?.costPerMergeUsd !== null && metrics?.costPerMergeUsd !== undefined ? `$${metrics.costPerMergeUsd.toFixed(2)}` : '--'}</div></div>
        <div className="plate" style={{ padding: '12px 14px' }}><div className="lbl" style={{ color: 'var(--ink2)' }}>wasted spend</div><div className="m" style={{ fontSize: 22, fontWeight: 700, marginTop: 4, color: 'var(--block)' }}>${(metrics?.wastedUsd ?? 0).toFixed(2)}</div></div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {rules.map((r) => <RuleCard key={r.id} rule={r} onApply={onApply} onDismiss={onDismiss} onRestore={onRestore} onUndo={onUndo} />)}
      </div>
    </div>
  );
}
