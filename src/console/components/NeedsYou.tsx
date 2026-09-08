import type { JSX } from 'react';
import { ACTIONS } from '../actions.js';
import { ActionButton } from './ActionButton.js';

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
  /** The owning lane's own repo, for a PR mention inside `title`/`line` -- `null` for
   *  the AWS integration plate, which names no lane of its own. */
  repo: string | null;
  sub: string;
  line: string;
  cta: string;
  ctaCls: 'btnP' | 'btnA' | 'btnR' | 'btnS';
  onClick: () => void;
  /** A catalog action behind the CTA. When set, the CTA renders with the full
   *  contract and `onClick` is not used. */
  action?: { spec: 'reconnectIntegration' | 'dismissAsk'; arg: string };
  /** The plate's trailing "label ▸" link, when it has one (the integration plate's
   *  "why + fix ▸", opening Settings). */
  more: { label: string; onClick: () => void } | null;
  /** A parked lane's own recommended option, one line under `line`. Null on every
   *  other kind of need, and on a parked lane whose ask carries no recommendation. */
  recommendedLine: string | null;
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
      id: `int-${integration.id}`, color: 'var(--block)', title: integration.name, titleId: null, repo: null,
      sub: `${integration.dependents.length} lanes blocked${since}`,
      line: integration.cause ?? '', cta: integration.fixLabel ?? 'Reconnect →',
      ctaCls: 'btnR', onClick: () => onFix('integration', integration.id),
      action: { spec: 'reconnectIntegration', arg: integration.id },
      more: integration.cause ? { label: 'why + fix', onClick: onOpenSettings } : null,
      recommendedLine: null,
    });
  }
  for (const lane of lanes) {
    const headline = laneHeadline(lane);
    if (lane.state === 'parked' && lane.question && isStaleAsk(lane.question, now)) {
      const key = lane.question.key;
      staleItems.push({
        id: `stale-${lane.id}`, color: 'var(--ink3)', title: `stale ask from ${headline.main}, ${ago(now - lane.question.askedAt)}`, repo: lane.repo,
        titleId: headline.runId, sub: '', line: 'nothing readable was asked; this will never resolve on its own',
        cta: 'Dismiss', ctaCls: 'btnS', onClick: () => onDismissAsk(key), more: null,
        action: { spec: 'dismissAsk', arg: key }, recommendedLine: null,
      });
      // A dismissed ask clears `lane.question` but leaves the lane `parked` -- nothing
      // resumes it on a dismiss. Without the `lane.question` guard below, that lane
      // fell straight into the ordinary "asks: -" plate forever: a dismiss never
      // actually left Needs You, it just changed which plate the lane showed as.
    } else if (lane.state === 'parked' && lane.question) {
      const question = lane.question.text;
      // W2 (2026-09-08): 140 characters, not the prototype's original 70
      // (script_wrapped.txt 199: `text.slice(0,70)+'…'`) -- enough of the question
      // to recognize it before opening the card. Still unconditional: the ellipsis
      // is appended even when the question is already short. It never covers an
      // inbox entry with no readable question -- every fixture it ships with has
      // one -- so a blank question here fell straight through as a bare `asks: `.
      // The em dash keeps that same shape without putting words in the run's mouth
      // for a question the console never actually read.
      const asks = question ? `${question.slice(0, 140)}…` : '—';
      const { recommended, opts } = lane.question;
      const recommendedLine = recommended !== null && recommended !== undefined && opts[recommended] !== undefined
        ? `Recommended: ${opts[recommended]}`
        : null;
      items.push({
        id: `park-${lane.id}`, color: 'var(--park)', title: headline.main, titleId: headline.runId, repo: lane.repo,
        sub: `waiting ${ago(now - lane.since)}`,
        line: `asks: ${asks}`, cta: 'Answer →', ctaCls: 'btnA',
        onClick: () => onFix('lane', lane.id), more: null, recommendedLine,
      });
    }
    if (lane.state === 'running' && lane.runaway) {
      const cap = lane.tokenCap ?? 0;
      items.push({
        id: `over-${lane.id}`, color: 'var(--block)', title: headline.main, titleId: headline.runId, repo: lane.repo,
        sub: `${fmtTokens(lane.tokens)} / ${fmtTokens(cap)}`,
        line: `retry loop ×${lane.fails} · burning ${fmtTokens(lane.tokensPerMin)} tokens/min`, cta: 'Kill attempt', ctaCls: 'btnR',
        onClick: () => onFix('lane', lane.id), more: null, recommendedLine: null,
      });
    }
  }
  return [...items, ...staleItems];
}

export interface NeedsYouProps {
  items: NeedItem[];
  /** Iteration 4: how many open blockers Aaron can act on right now -- a bare count,
   *  never rendered when zero. `onOpenBlockers` jumps to the Blockers view. */
  blockersCount?: number;
  onOpenBlockers?: () => void;
}

/** Needs-you strip: one plate per item with the fix button, hidden when empty. */
export function NeedsYou({ items, blockersCount = 0, onOpenBlockers }: NeedsYouProps): JSX.Element | null {
  if (items.length === 0 && blockersCount === 0) return null;
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
              <Linkify text={n.title} repo={n.repo} /> <span style={{ color: 'var(--ink2)', fontWeight: 500 }}>{n.sub}</span>
            </div>
            <div className="m" style={{ fontSize: 10, color: 'var(--ink2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              <Linkify text={n.line} repo={n.repo} />
              {n.more ? <> · <a style={{ color: 'var(--ink3)' }} onClick={n.more.onClick}>{n.more.label} ▸</a></> : null}
            </div>
            {n.recommendedLine ? (
              <div className="m" style={{ fontSize: 'var(--fs-meta)', color: 'var(--hand)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {n.recommendedLine}
              </div>
            ) : null}
          </div>
          {n.action?.spec === 'reconnectIntegration' ? (
            <ActionButton
              spec={ACTIONS.reconnectIntegration} args={[n.action.arg]} actionRef={`needs-${n.action.arg}`} className={n.ctaCls}
              style={{ padding: '7px 11px', fontSize: '9.5px', flex: 'none', whiteSpace: 'nowrap' }} busy="Reconnecting…"
            >
              {n.cta}
            </ActionButton>
          ) : n.action?.spec === 'dismissAsk' ? (
            <ActionButton
              spec={ACTIONS.dismissAsk} args={[n.action.arg]} actionRef={`needs-${n.action.arg}`} className={n.ctaCls}
              style={{ padding: '7px 11px', fontSize: '9.5px', flex: 'none', whiteSpace: 'nowrap' }} busy="Dismissing…"
            >
              {n.cta}
            </ActionButton>
          ) : (
            <span className={n.ctaCls} style={{ padding: '7px 11px', fontSize: '9.5px', flex: 'none', whiteSpace: 'nowrap' }} onClick={n.onClick}>{n.cta}</span>
          )}
        </div>
      ))}
      {blockersCount > 0 ? (
        <span className="chip chipB" style={{ alignSelf: 'center' }} onClick={onOpenBlockers}>
          {blockersCount} blocker{blockersCount === 1 ? '' : 's'}
        </span>
      ) : null}
    </div>
  );
}
