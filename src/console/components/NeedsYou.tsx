import type { JSX } from 'react';

import { hm } from '../freshness.js';
import type { Integration, Lane } from '../../shared/console-model.js';

export interface NeedItem {
  id: string;
  color: string;
  title: string;
  sub: string;
  line: string;
  cta: string;
  ctaCls: 'btnP' | 'btnA' | 'btnR' | 'btnS';
  onClick: () => void;
}

export function buildNeeds(
  lanes: Lane[],
  integrations: Integration[],
  onFix: (item: 'integration' | 'lane', id: string) => void,
): NeedItem[] {
  const items: NeedItem[] = [];
  for (const integration of integrations) {
    if (integration.status !== 'down') continue;
    const since = integration.since !== null ? ` · since ${hm(integration.since)}` : '';
    items.push({
      id: `int-${integration.id}`, color: 'var(--block)', title: integration.name, sub: 'disconnected',
      line: `${integration.dependents.length} lanes blocked${since}`, cta: integration.fixLabel ?? 'Reconnect →',
      ctaCls: 'btnR', onClick: () => onFix('integration', integration.id),
    });
  }
  for (const lane of lanes) {
    if (lane.state === 'parked') {
      const question = lane.question?.text ?? '';
      const asks = question.length > 60 ? `${question.slice(0, 60)}…` : question;
      items.push({
        id: `park-${lane.id}`, color: 'var(--park)', title: lane.id, sub: 'parked',
        line: `asks: ${asks}`, cta: 'Answer →', ctaCls: 'btnA',
        onClick: () => onFix('lane', lane.id),
      });
    }
    if (lane.state === 'running' && lane.runaway) {
      items.push({
        id: `over-${lane.id}`, color: 'var(--block)', title: lane.id, sub: 'over cap',
        line: `burning $${lane.burnUsdPerMin.toFixed(2)}/min · ${lane.fails} fails`, cta: 'Kill attempt', ctaCls: 'btnR',
        onClick: () => onFix('lane', lane.id),
      });
    }
  }
  return items;
}

export interface NeedsYouProps {
  items: NeedItem[];
}

/** Needs-you strip: one plate per item with the fix button, hidden when empty. */
export function NeedsYou({ items }: NeedsYouProps): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 10, padding: '10px 16px', background: 'var(--panel2)', borderBottom: '2px solid var(--line2)', alignItems: 'stretch', flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 10px 0 4px', borderRight: '1px solid var(--line2)' }}>
        <span className="lbl">Needs you</span>
        <span className="m" style={{ fontSize: 22, fontWeight: 700, color: 'var(--park)' }}>{items.length}</span>
      </div>
      {items.map((n) => (
        <div key={n.id} className="plate" style={{ flex: '1 1 300px', display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderColor: n.color }}>
          <span className="led" style={{ background: n.color }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="m" style={{ fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {n.title} <span style={{ color: 'var(--ink2)', fontWeight: 500 }}>{n.sub}</span>
            </div>
            <div className="m" style={{ fontSize: 10, color: 'var(--ink2)' }}>{n.line}</div>
          </div>
          <span className={n.ctaCls} style={{ padding: '7px 11px', fontSize: '9.5px' }} onClick={n.onClick}>{n.cta}</span>
        </div>
      ))}
    </div>
  );
}
