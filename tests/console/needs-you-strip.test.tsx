// @vitest-environment jsdom
/**
 * R-75 item 3 (spec `doctrine/design/operator-experience.md` §5). Aaron, 2026-09-11:
 * "questions need to be asked differently somehow than they are now". Decided the same
 * day: one question at a time, in a strip above the tabs, recommended option first,
 * blockers before confirms before questions, a counter, and number keys.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { NeedsYou, buildNeeds } from '../../src/console/components/NeedsYou.js';
import type { Lane, Message } from '../../src/shared/console-model.js';

const now = Date.now();

function lane(extra: Partial<Lane> & { id: string }): Lane {
  return {
    title: 'A title', kind: 'ticket', sourceUrl: null, plain: 'Working on it.', mergeable: null, attempts: 1, retiredAt: null,
    ticket: extra.id, model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement', repo: 'o/r', attempt: 1, state: 'running',
    reason: null, stepN: 1, stepTotal: 6, stepText: 'working', ctxTokens: 1, ctxCeiling: 2, ctxCompactAt: 2, tokens: 1, tokenCap: null,
    tokensPerMin: 0, fails: 0, hop: 0, hopStatus: 'live', observedAt: now, verifiedAt: now, heart: true, since: now - 60_000, startedAt: now - 60_000,
    endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false, needsAaron: null,
    live: { alive: true, pid: 1, lastEventAt: now, checkedAt: now }, did: null, didVerbatim: false, now: 'Working on it.', you: null, ...extra,
  } as Lane;
}

/** Two lanes with an open question, and one raised blocker card off the thread
 *  response's `cards` field: three things that need a person, of two kinds. */
function threeAsks(): { lanes: Lane[]; cards: Message[] } {
  const lanes = [
    lane({
      id: 'FLT-201', stepText: 'running the unit suite', reason: 'the retry budget ran out',
      question: { key: 'ask-a', text: 'Retry the flaky test or skip it?', opts: ['Retry once more', 'Skip it for now'], askedAt: now - 60_000, recommended: 0, optionSource: 'worker' },
    }),
    lane({
      id: 'FLT-202', stepText: 'opening the draft PR',
      question: { key: 'ask-b', text: 'Which base branch should the PR target?', opts: ['main', 'develop'], askedAt: now - 30_000, recommended: 0, optionSource: 'drafted' },
    }),
  ];
  const cards: Message[] = [
    {
      k: 'blocker-1', type: 'blocker', text: 'the Sentry token expired', ts: now - 10_000, source: 'FLT-203', lane: 'FLT-203',
      kicker: 'Blocked · FLT-203', title: 'FLT-203 cannot go on: the Sentry token expired',
      body: 'The agent is parked until it clears.',
      btns: [{ label: 'Open Blockers and clear it', cmd: 'open blockers', cls: 'answer' }],
    },
  ];
  return { lanes, cards };
}

function renderStrip(lanes: Lane[], cards: Message[], onCommand = vi.fn()) {
  const items = buildNeeds(lanes, cards);
  render(<NeedsYou items={items} now={now} onCommand={onCommand} />);
  return { onCommand, items };
}

describe('the Needs-you strip shows one thing at a time (R-75 item 3)', () => {
  it('renders exactly one card out of three, the blocker first, counted "1 of 3"', () => {
    const { lanes, cards } = threeAsks();
    renderStrip(lanes, cards);
    expect(screen.getAllByTestId('question-card')).toHaveLength(1);
    expect(screen.getByTestId('needs-you-counter')).toHaveTextContent('1 of 3');
    expect(screen.getByTestId('question-card').textContent).toContain('the Sentry token expired');
  });

  it('orders blockers, then confirms, then questions, oldest first inside a kind', () => {
    const { lanes, cards } = threeAsks();
    const withConfirm: Message[] = [
      ...cards,
      { k: 'confirm-1', type: 'confirm', text: 'confirm?', ts: now - 5_000, source: 'FLT-204', lane: 'FLT-204', title: 'Retire FLT-204', blast: 'its worktree and process are gone' },
    ];
    const items = buildNeeds(lanes, withConfirm);
    expect(items.map((item) => item.kind)).toEqual(['blocker', 'confirm', 'lane', 'lane']);
    // Oldest first inside the question kind: ask-a was asked 60s ago, ask-b 30s ago.
    expect(items.filter((item) => item.kind === 'lane').map((item) => item.askKey)).toEqual(['ask-a', 'ask-b']);
  });

  it('next and previous move the index and the card', async () => {
    const { lanes, cards } = threeAsks();
    renderStrip(lanes, cards);
    await userEvent.click(screen.getByTestId('needs-you-next'));
    expect(screen.getByTestId('needs-you-counter')).toHaveTextContent('2 of 3');
    expect(screen.getByTestId('question-card').textContent).toContain('Retry the flaky test or skip it?');
    await userEvent.click(screen.getByTestId('needs-you-prev'));
    expect(screen.getByTestId('needs-you-counter')).toHaveTextContent('1 of 3');
    expect(screen.getByTestId('question-card').textContent).toContain('the Sentry token expired');
  });

  it('collapses to one line when nothing needs a person', () => {
    render(<NeedsYou items={buildNeeds([], [])} now={now} onCommand={vi.fn()} />);
    expect(screen.getByTestId('needs-you-empty')).toHaveTextContent('Nothing needs you');
    expect(screen.queryByTestId('question-card')).not.toBeInTheDocument();
  });
});

describe('the strip answers by number key (R-75 item 3)', () => {
  it('pressing 2 posts the second option of the card on screen, exactly', async () => {
    const { lanes, cards } = threeAsks();
    const { onCommand } = renderStrip(lanes, cards);
    await userEvent.click(screen.getByTestId('needs-you-next'));
    fireEvent.keyDown(document, { key: '2' });
    expect(onCommand).toHaveBeenCalledWith('FLT-201', 'answer ask-a Skip it for now');
  });

  it('a five-option ask renders all five, with number keys on the first four only', async () => {
    const five = [lane({
      id: 'FLT-210', stepText: 'choosing a rollout',
      question: {
        key: 'ask-5', text: 'How should this roll out?', askedAt: now - 1_000, recommended: 0, optionSource: 'drafted',
        opts: ['Ship it now', 'Ship behind a flag', 'Wait for QA', 'Hold for the release train', 'Drop it'],
      },
    })];
    const { onCommand } = renderStrip(five, []);
    const options = screen.getAllByTestId('question-option');
    expect(options).toHaveLength(5);
    expect(options.slice(0, 4).map((o) => o.getAttribute('data-key'))).toEqual(['1', '2', '3', '4']);
    expect(options[4]!.getAttribute('data-key')).toBeNull();
    // The fifth is still answerable, by click.
    await userEvent.click(options[4]!);
    expect(onCommand).toHaveBeenCalledWith('FLT-210', 'answer ask-5 Drop it');
    // And no key answers it.
    onCommand.mockClear();
    fireEvent.keyDown(document, { key: '5' });
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('a digit typed into a focused text field answers nothing', async () => {
    const { lanes, cards } = threeAsks();
    const onCommand = vi.fn();
    const items = buildNeeds(lanes, cards);
    render(
      <>
        <NeedsYou items={items} now={now} onCommand={onCommand} />
        <textarea data-testid="rail-composer" />
      </>,
    );
    const composer = screen.getByTestId('rail-composer');
    composer.focus();
    expect(document.activeElement).toBe(composer);
    fireEvent.keyDown(composer, { key: '2', bubbles: true });
    expect(onCommand).not.toHaveBeenCalled();
  });
});

describe('the strip carries the ask\'s evidence behind a disclosure (R-75 item 3)', () => {
  it('is closed by default and opens onto that ask\'s own step and context', async () => {
    const { lanes, cards } = threeAsks();
    renderStrip(lanes, cards);
    await userEvent.click(screen.getByTestId('needs-you-next'));
    expect(screen.queryByText(/running the unit suite/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('question-evidence'));
    const body = screen.getByTestId('question-evidence-body');
    expect(within(body).getByText(/running the unit suite/)).toBeInTheDocument();
    expect(within(body).getByText(/the retry budget ran out/)).toBeInTheDocument();
  });

  it('shows the evidence of the card on screen, not of another ask', async () => {
    const { lanes, cards } = threeAsks();
    renderStrip(lanes, cards);
    await userEvent.click(screen.getByTestId('needs-you-next'));
    await userEvent.click(screen.getByTestId('needs-you-next'));
    await userEvent.click(screen.getByTestId('question-evidence'));
    const body = screen.getByTestId('question-evidence-body');
    expect(within(body).getByText(/opening the draft PR/)).toBeInTheDocument();
    expect(within(body).queryByText(/running the unit suite/)).not.toBeInTheDocument();
  });
});

describe('the recommended option comes first (R-75 item 3)', () => {
  it('puts the pipeline\'s recommendation at the top and marks it', () => {
    const recommendedSecond = [lane({
      id: 'FLT-220', stepText: 'picking a base',
      question: { key: 'ask-r', text: 'Which base?', opts: ['develop', 'main'], askedAt: now, recommended: 1, optionSource: 'drafted' },
    })];
    renderStrip(recommendedSecond, []);
    const options = screen.getAllByTestId('question-option');
    expect(options[0]!.textContent).toContain('main');
    expect(options[0]!.getAttribute('data-recommended')).toBe('true');
    expect(options[1]!.getAttribute('data-recommended')).toBe('false');
  });
});
