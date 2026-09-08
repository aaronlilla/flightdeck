import type { JSX } from 'react';

import { ago, hm } from '../freshness.js';
import { laneHeadline } from '../laneVM.js';
import { Linkify } from './Linkify.js';
import type { Integration, Lane } from '../../shared/console-model.js';
import { fmtTokens } from '../../shared/format-tokens.js';

export interface NeedItem {
  id: string;
  color: string;
  title: string;
  /** The full run id for the plate title's `title` attribute (a lane's `runId`,
   *  null for the AWS integration plate, which names no single lane). */
  titleId: string | null;
  sub: string;
  line: string;
  cta: string;
  ctaCls: 'btnP' | 'btnA' | 'btnR' | 'btnS';
  onClick: () => void;
  /** The plate's trailing "label ▸" link, when it has one (the integration plate's
   *  "why + fix ▸", opening Settings). */
  more: { label: string; onClick: () => void } | null;
}

/** An ask past this age with no readable question text is never going to become
 *  answerable -- there is nothing there to answer, and it should stop presenting as
 *  a normal question the moment it's clearly abandoned rather than sitting at the
 *  top of the board forever. */
const STALE_ASK_AGE_MS = 24 * 60 * 60_000;

function isStaleAsk(question: { text: string; askedAt: number } | null, now: number): boolean {
  if (!question) return false;
  return question.text.trim() === '' && now - question.askedAt > STALE_ASK_AGE_MS;
}

export function buildNeeds(
  lanes: Lane[],
  integrations: Integration[],
  onFix: (item: 'integration' | 'lane', id: string) => void,
  onOpenSettings: () => void = () => undefined,
  now: number = Date.now(),
  onDismissAsk: (key: string) => void = () => undefined,
): NeedItem[] {
  const items: NeedItem[] = [];
  // Stale asks never lead the board -- collected separately and appended at the end,
  // after every ordinary need, so a genuinely abandoned question never displaces a
  // down integration or a live question someone can actually still answer.
  const staleItems: NeedItem[] = [];
  for (const integration of integrations) {
    if (integration.status !== 'down') continue;
    const since = integration.since !== null ? ` · since ${hm(integration.since)}` : '';
    items.push({
      id: `int-${integration.id}`, color: 'var(--block)', title: integration.name, titleId: null,
      sub: `${integration.dependents.length} lanes blocked${since}`,
      line: integration.cause ?? '', cta: integration.fixLabel ?? 'Reconnect →',
      ctaCls: 'btnR', onClick: () => onFix('integration', integration.id),
      more: integration.cause ? { label: 'why + fix', onClick: onOpenSettings } : null,
    });
  }
  for (const lane of lanes) {
    const headline = laneHeadline(lane);
    if (lane.state === 'parked' && lane.question && isStaleAsk(lane.question, now)) {
      const key = lane.question.key;
      staleItems.push({
        id: `stale-${lane.id}`, color: 'var(--ink3)', title: `stale ask from ${headline.main}, ${ago(now - lane.question.askedAt)}`,
        titleId: headline.runId, sub: '', line: 'nothing readable was asked; this will never resolve on its own',
        cta: 'Dismiss', ctaCls: 'btnS', onClick: () => onDismissAsk(key), more: null,
      });
      // A dismissed ask clears `lane.question` but leaves the lane `parked` -- nothing
      // resumes it on a dismiss. Without the `lane.question` guard below, that lane
      // fell straight into the ordinary "asks: -" plate forever: a dismiss never
      // actually left Needs You, it just changed which plate the lane showed as.
    } else if (lane.state === 'parked' && lane.question) {
      const question = lane.question.text;
      // The prototype's own plate: `asks: ` plus the question, truncated to 70 chars
      // with an unconditional "…" (script_wrapped.txt 199: `text.slice(0,70)+'…'`,
      // appended even when the question is already short). It never covers an inbox
      // entry with no readable question -- every fixture it ships with has one -- so
      // a blank question here fell straight through as a bare `asks: `. The em dash
      // keeps that same shape without putting words in the run's mouth for a question
      // the console never actually read.
      const asks = question ? `${question.slice(0, 70)}…` : '—';
      items.push({
        id: `park-${lane.id}`, color: 'var(--park)', title: headline.main, titleId: headline.runId,
        sub: `waiting ${ago(now - lane.since)}`,
        line: `asks: ${asks}`, cta: 'Answer →', ctaCls: 'btnA',
        onClick: () => onFix('lane', lane.id), more: null,
      });
    }
    if (lane.state === 'running' && lane.runaway) {
      const cap = lane.tokenCap ?? 0;
      items.push({
        id: `over-${lane.id}`, color: 'var(--block)', title: headline.main, titleId: headline.runId,
        sub: `${fmtTokens(lane.tokens)} / ${fmtTokens(cap)}`,
        line: `retry loop ×${lane.fails} · burning ${fmtTokens(lane.tokensPerMin)} tokens/min`, cta: 'Kill attempt', ctaCls: 'btnR',
        onClick: () => onFix('lane', lane.id), more: null,
      });
    }
  }
  return [...items, ...staleItems];
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
        <div key={n.id} className="plate" style={{ flex: '1 1 220px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderColor: n.color }}>
          <span className="led" style={{ background: n.color, flex: 'none' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="m" title={n.titleId ?? undefined} style={{ fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              <Linkify text={n.title} /> <span style={{ color: 'var(--ink2)', fontWeight: 500 }}>{n.sub}</span>
            </div>
            <div className="m" style={{ fontSize: 10, color: 'var(--ink2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              <Linkify text={n.line} />
              {n.more ? <> · <a style={{ color: 'var(--ink3)' }} onClick={n.more.onClick}>{n.more.label} ▸</a></> : null}
            </div>
          </div>
          <span className={n.ctaCls} style={{ padding: '7px 11px', fontSize: '9.5px', flex: 'none', whiteSpace: 'nowrap' }} onClick={n.onClick}>{n.cta}</span>
        </div>
      ))}
    </div>
  );
}
