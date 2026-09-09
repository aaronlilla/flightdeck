import type { JSX } from 'react';

import { ACTIONS, useAction } from '../actions.js';
import type { ProposalsResponse, ReviewMetrics } from '../../shared/console-model.js';
import { fmtTokens } from '../../shared/format-tokens.js';
import { reviewNotesFor, type ReviewTile } from '../../shared/review-notes.js';
import { NarratedLine } from './Narrated.js';
import { Marks } from './QuestionCard.js';

/**
 * `Flightdeck Console.dc.html` 1f: today's six figures off the journal (tickets in, PRs
 * merged, handed to QA, blockers cleared, tokens spent, the slowest step) and the one
 * change worth making, which is the top open proposal with Apply and Not now.
 */
export interface FlightReviewProps {
  proposals: ProposalsResponse | null;
  /** `?verbose=1`: each tile's fact record under its sentence. */
  verbose?: boolean;
  now: number;
  tokensToday?: number;
  dailyTokens?: number;
}

interface Tile { key: ReviewTile; label: string; value: string; note: string; color: string; border: string }

function tiles(metrics: ReviewMetrics, tokensToday: number | undefined, dailyTokens: number | undefined): Tile[] {
  const count = (value: number | undefined): string => (value === undefined ? 'not measured' : String(value));
  const tokens = tokensToday ?? 0;
  // The route composes these sentences so the narrator can reach them; an older response
  // that predates the field is composed here from the same shared function, so the screen
  // never falls back to a second wording of its own.
  const notes = metrics.notes ?? reviewNotesFor(metrics, tokens, dailyTokens ?? null);
  const slowest = metrics.slowestHop;
  return [
    { key: 'ticketsIn', label: 'Tickets in', value: count(metrics.ticketsIn), note: notes['ticketsIn'] ?? '', color: 'var(--ink)', border: 'var(--line)' },
    { key: 'mergedToday', label: 'PRs merged', value: String(metrics.mergedToday), note: notes['mergedToday'] ?? '', color: 'var(--acc)', border: 'var(--acc)' },
    { key: 'handedToQa', label: 'Handed to QA', value: count(metrics.handedToQa), note: notes['handedToQa'] ?? '', color: 'var(--ink)', border: 'var(--line)' },
    { key: 'blockersCleared', label: 'Blockers cleared', value: count(metrics.blockersCleared), note: notes['blockersCleared'] ?? '', color: 'var(--ink)', border: 'var(--line)' },
    { key: 'tokensToday', label: 'Tokens spent', value: fmtTokens(tokens), note: notes['tokensToday'] ?? '', color: 'var(--ink)', border: 'var(--line)' },
    {
      key: 'slowestHop',
      label: 'Slowest step',
      value: slowest ? `${slowest.minutes} min` : metrics.humanWaitMin > 0 ? `${metrics.humanWaitMin} min` : 'none',
      note: notes['slowestHop'] ?? '',
      color: slowest || metrics.humanWaitMin > 0 ? 'var(--warn)' : 'var(--ink)', border: slowest || metrics.humanWaitMin > 0 ? 'var(--warn)' : 'var(--line)',
    },
  ];
}

export function FlightReview({ proposals, now, tokensToday, dailyTokens, verbose }: FlightReviewProps): JSX.Element {
  const top = proposals?.rules.find((rule) => rule.status === 'open') ?? null;
  const apply = useAction(ACTIONS.applyProposal, top?.id);
  const dismiss = useAction(ACTIONS.dismissProposal, top?.id);
  const metrics = proposals?.metrics;
  const result = apply.result?.kind === 'done' ? apply.result : dismiss.result?.kind === 'done' ? dismiss.result : null;
  return (
    <main data-testid="flight-review" className="scroll" style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '26px 28px', display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 18 }}>
        {(metrics ? tiles(metrics, tokensToday, dailyTokens) : []).map((tile) => (
          <div key={tile.label} data-testid="metric" style={{ position: 'relative', border: `1px solid ${tile.border}`, padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 6, minHeight: 170 }}>
            <Marks />
            <span className="kick" style={{ letterSpacing: '.12em' }}>{tile.label}</span>
            <span className="hd" style={{ fontSize: 'var(--fs-metric)', lineHeight: 1, color: tile.color, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere', minWidth: 0 }}>{tile.value}</span>
            {tile.note || proposals?.metrics.narration?.[tile.key]
              ? <p style={{ margin: 'auto 0 0', color: 'var(--ink2)' }}><NarratedLine bag={proposals?.metrics.narration} field={tile.key} glance={tile.note} testid={`review-${tile.key}`} {...(verbose === undefined ? {} : { verbose })} /></p>
              : null}
          </div>
        ))}
      </div>
      {top ? (
        <div data-testid="proposal" style={{ position: 'relative', border: '1px solid var(--line)', padding: '16px 20px', display: 'grid', gridTemplateColumns: '1fr auto', gap: 20, alignItems: 'center', background: 'var(--panel)' }}>
          <div>
            <span className="kick" style={{ letterSpacing: '.12em' }}>Proposal</span>
            <p style={{ margin: '4px 0 0', fontSize: 'var(--fs-key)' }}>{top.title}. {top.summary}</p>
            {result ? <span style={{ fontSize: 'var(--fs-meta)', color: result.ok ? 'var(--ink3)' : 'var(--warn)' }}>{result.text}</span> : null}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn" style={{ padding: '7px 14px' }} aria-busy={dismiss.pending} onClick={() => void dismiss.run(top.id)}>Not now</button>
            <button type="button" className="btn primary" style={{ padding: '7px 14px' }} aria-busy={apply.pending} onClick={() => void apply.run(top.id)}>Apply</button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
