import type { JSX } from 'react';

import { ago, hm } from '../freshness.js';
import { laneHeadline } from '../laneVM.js';
import type { Integration, Lane } from '../../shared/console-model.js';

export interface NeedItem {
  id: string;
  color: string;
  title: string;
  /** The run id, shown small next to the title, only when the title is a ticket. */
  runId: string | null;
  sub: string;
  line: string;
  cta: string;
  ctaCls: 'btnP' | 'btnA' | 'btnR' | 'btnS';
  onClick: () => void;
  /** The plate's trailing "label ▸" link, when it has one (the integration plate's
   *  "why + fix ▸", opening Settings). */
  more: { label: string; onClick: () => void } | null;
}

export function buildNeeds(
  lanes: Lane[],
  integrations: Integration[],
  onFix: (item: 'integration' | 'lane', id: string) => void,
  onOpenSettings: () => void = () => undefined,
  now: number = Date.now(),
): NeedItem[] {
  const items: NeedItem[] = [];
  for (const integration of integrations) {
    if (integration.status !== 'down') continue;
    const since = integration.since !== null ? ` · since ${hm(integration.since)}` : '';
    items.push({
      id: `int-${integration.id}`, color: 'var(--block)', title: integration.name, runId: null,
      sub: `${integration.dependents.length} lanes blocked${since}`,
      line: integration.cause ?? '', cta: integration.fixLabel ?? 'Reconnect →',
      ctaCls: 'btnR', onClick: () => onFix('integration', integration.id),
      more: integration.cause ? { label: 'why + fix', onClick: onOpenSettings } : null,
    });
  }
  for (const lane of lanes) {
    const headline = laneHeadline(lane);
    if (lane.state === 'parked') {
      const question = lane.question?.text ?? '';
      // The prototype's own plate: `asks: ` plus the question, truncated to 70 chars
      // with an unconditional "…" (script_wrapped.txt 199: `text.slice(0,70)+'…'`,
      // appended even when the question is already short). It never covers an inbox
      // entry with no readable question -- every fixture it ships with has one -- so
      // a blank question here fell straight through as a bare `asks: `. The em dash
      // keeps that same shape without putting words in the run's mouth for a question
      // the console never actually read.
      const asks = question ? `${question.slice(0, 70)}…` : '—';
      items.push({
        id: `park-${lane.id}`, color: 'var(--park)', title: headline.main, runId: headline.sub,
        sub: `waiting ${ago(now - lane.since)}`,
        line: `asks: ${asks}`, cta: 'Answer →', ctaCls: 'btnA',
        onClick: () => onFix('lane', lane.id), more: null,
      });
    }
    if (lane.state === 'running' && lane.runaway) {
      const cap = lane.capUsd ?? 0;
      items.push({
        id: `over-${lane.id}`, color: 'var(--block)', title: headline.main, runId: headline.sub,
        sub: `$${lane.costUsd.toFixed(2)} / $${cap}`,
        line: `retry loop ×${lane.fails} · burning $${lane.burnUsdPerMin.toFixed(2)}/min`, cta: 'Kill attempt', ctaCls: 'btnR',
        onClick: () => onFix('lane', lane.id), more: null,
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
              {n.title}
              {n.runId ? <span title={n.runId} style={{ color: 'var(--ink3)', fontWeight: 500, marginLeft: 6, fontSize: 10 }}>{n.runId}</span> : null}
              {' '}<span style={{ color: 'var(--ink2)', fontWeight: 500 }}>{n.sub}</span>
            </div>
            <div className="m" style={{ fontSize: 10, color: 'var(--ink2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {n.line}
              {n.more ? <> · <a style={{ color: 'var(--ink3)' }} onClick={n.more.onClick}>{n.more.label} ▸</a></> : null}
            </div>
          </div>
          <span className={n.ctaCls} style={{ padding: '7px 11px', fontSize: '9.5px' }} onClick={n.onClick}>{n.cta}</span>
        </div>
      ))}
    </div>
  );
}
