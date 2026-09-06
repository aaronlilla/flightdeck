// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FlightReview } from '../../src/console/components/FlightReview.js';
import type { ProposalsResponse, Rule } from '../../src/shared/console-model.js';

function rule(extra: Partial<Rule> = {}): Rule {
  return {
    id: 'r1', kind: 'cost', title: 'a rule', summary: 'summary', evidence: 'evidence', effect: 'effect',
    status: 'open', jid: null, prUrl: null,
    ...extra,
  };
}

function proposals(rules: Rule[]): ProposalsResponse {
  return {
    rules,
    metrics: {
      mergedToday: 0, humanWaitMin: 0, tokensPerMerge: null, tokensWasted: 0,
    },
    computedAt: Date.now(),
  };
}

const noop = vi.fn();

function renderReview(rules: Rule[], now = Date.now()) {
  return render(
    <FlightReview
      proposals={proposals(rules)} now={now}
      onApply={noop} onDismiss={noop} onRestore={noop} onUndo={noop}
    />,
  );
}

// FIDELITY-DIFFS row 60: rule kind drives a taxon label and the plate border color,
// not the raw internal kind id.
describe('FlightReview kind taxonomy', () => {
  it('shows COST for a cost-kind rule', () => {
    renderReview([rule({ kind: 'cost' })]);
    expect(screen.getByText('COST')).toBeInTheDocument();
    expect(screen.queryByText('cost')).not.toBeInTheDocument();
  });

  it('maps the generated kill-after-fails kind onto COST', () => {
    renderReview([rule({ kind: 'kill-after-fails' })]);
    expect(screen.getByText('COST')).toBeInTheDocument();
  });

  it('shows HUMAN WAIT for auto-answer and SPEED for self-iteration', () => {
    renderReview([rule({ id: 'r1', kind: 'auto-answer' }), rule({ id: 'r2', kind: 'self-iteration' })]);
    expect(screen.getByText('HUMAN WAIT')).toBeInTheDocument();
    expect(screen.getByText('SPEED')).toBeInTheDocument();
  });

  it('falls back to the raw kind, upper-cased, for an unknown taxon rather than guessing', () => {
    renderReview([rule({ kind: 'mystery' })]);
    expect(screen.getByText('MYSTERY')).toBeInTheDocument();
  });
});

// Final fidelity sweep #4: the Apply rule button's color comes from the rule kind
// (script_wrapped.txt seeds `btn: 'btnP'` for cost/speed, `'btnA'` for human wait),
// not one fixed style for every kind.
describe('FlightReview Apply rule button color', () => {
  it('uses btnA for a human-wait kind rule', () => {
    renderReview([rule({ kind: 'auto-answer' })]);
    expect(screen.getByText('Apply rule →')).toHaveClass('btnA');
  });

  it('uses btnP for a cost-kind rule', () => {
    renderReview([rule({ kind: 'cost' })]);
    expect(screen.getByText('Apply rule →')).toHaveClass('btnP');
  });

  it('uses btnP for a speed-kind rule', () => {
    renderReview([rule({ kind: 'self-iteration' })]);
    expect(screen.getByText('Apply rule →')).toHaveClass('btnP');
  });
});

describe('FlightReview evidence toggle', () => {
  it('starts collapsed with the evidence glyph by default', () => {
    renderReview([rule({ expanded: false })]);
    expect(screen.getByText('evidence ▸')).toBeInTheDocument();
  });

  it('starts expanded, with the collapse glyph, when the rule seeds expanded: true', () => {
    renderReview([rule({ expanded: true })]);
    expect(screen.getByText('collapse ▴')).toBeInTheDocument();
    expect(screen.getByText(/evidence$/)).toBeInTheDocument();
  });
});

describe('FlightReview header', () => {
  it('appends the current clock time to the header', () => {
    const now = new Date(2026, 0, 1, 14, 7, 0).getTime();
    renderReview([], now);
    expect(screen.getByText('Flight review · 14:07')).toBeInTheDocument();
  });
});
