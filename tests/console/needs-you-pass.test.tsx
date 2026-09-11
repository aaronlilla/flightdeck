// @vitest-environment jsdom
/**
 * R-75 item 4 (spec `doctrine/design/operator-experience.md` §3). A question Aaron
 * cannot answer is handed to a teammate from the card itself. The command goes through
 * the existing command route as `pass <askKey> <name>`; this stream renders the four
 * shared `LaneQuestion` fields, stream C (R-76) writes them.
 *
 * Optimistic, with the standard fallback (spec §10; Aaron, 2026-09-11: "immediate
 * obvious feedback"). The click applies its state AT ONCE, with a pending mark, before
 * the server answers. A refusal rolls the card back with the reason inline and a Retry.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
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

function askLane(question: Partial<Lane['question']> = {}): Lane {
  return lane({
    id: 'FLT-301', stepText: 'waiting on a call', reason: 'the schema changed under it',
    question: {
      key: 'ask-p', text: 'Do we keep the old column?', opts: ['Keep it', 'Drop it'],
      askedAt: now - 20_000, recommended: 0, optionSource: 'worker', ...question,
    } as Lane['question'],
  });
}

type CommandFn = (laneId: string, command: string) => void | Promise<unknown>;

function renderStrip(lanes: Lane[], cards: Message[] = [], onCommand: CommandFn = vi.fn()) {
  const items = buildNeeds(lanes, cards, now);
  render(<NeedsYou items={items} now={now} onCommand={onCommand} />);
  return { onCommand };
}

const NAMES = ['Jason', 'Joe', 'Haiping', 'Harrison'];

describe('Pass to… hands the question to a teammate (R-75 item 4)', () => {
  it('offers the four names and posts the exact command string', async () => {
    const { onCommand } = renderStrip([askLane()]);
    await userEvent.click(screen.getByTestId('question-pass'));
    const menu = screen.getByTestId('question-pass-menu');
    expect(within(menu).getAllByRole('button').map((b) => b.textContent)).toEqual(NAMES);
    await userEvent.click(within(menu).getByText('Joe'));
    expect(onCommand).toHaveBeenCalledWith('FLT-301', 'pass ask-p Joe');
  });

  it('shows the passed line with a pending mark before the server answers', async () => {
    // A command that never settles: the assertion runs with the request still open.
    const onCommand = vi.fn(() => new Promise<never>(() => {}));
    renderStrip([askLane()], [], onCommand as CommandFn);
    await userEvent.click(screen.getByTestId('question-pass'));
    await userEvent.click(within(screen.getByTestId('question-pass-menu')).getByText('Haiping'));

    const passed = screen.getByTestId('question-passed');
    expect(passed).toHaveTextContent('Passed to Haiping');
    expect(passed.getAttribute('data-pending')).toBe('true');
    // The options are hidden while it is out with someone.
    expect(screen.queryByTestId('question-options')).not.toBeInTheDocument();
  });

  it('a refusal rolls the card back to its options, with the reason and a Retry', async () => {
    const onCommand = vi.fn().mockRejectedValue(new Error('pass: unknown command'));
    renderStrip([askLane()], [], onCommand);
    await userEvent.click(screen.getByTestId('question-pass'));
    await userEvent.click(within(screen.getByTestId('question-pass-menu')).getByText('Jason'));

    await waitFor(() => expect(screen.getByTestId('question-pass-error')).toBeInTheDocument());
    expect(screen.getByTestId('question-pass-error')).toHaveTextContent('pass: unknown command');
    expect(screen.getByTestId('question-pass-retry')).toBeInTheDocument();
    // Rolled back: the options are rendered and enabled again, the passed line is gone.
    expect(screen.queryByTestId('question-passed')).not.toBeInTheDocument();
    const options = screen.getAllByTestId('question-option');
    expect(options).toHaveLength(2);
    for (const option of options) expect(option).toBeEnabled();
  });

  it('Retry posts the same command again', async () => {
    const onCommand = vi.fn().mockRejectedValue(new Error('pass: unknown command'));
    renderStrip([askLane()], [], onCommand);
    await userEvent.click(screen.getByTestId('question-pass'));
    await userEvent.click(within(screen.getByTestId('question-pass-menu')).getByText('Jason'));
    await waitFor(() => expect(screen.getByTestId('question-pass-retry')).toBeInTheDocument());
    onCommand.mockClear();
    await userEvent.click(screen.getByTestId('question-pass-retry'));
    expect(onCommand).toHaveBeenCalledWith('FLT-301', 'pass ask-p Jason');
  });
});

describe('a question already passed renders from the server\'s own fields (R-75 item 4)', () => {
  it('an ask carrying passedTo shows the passed line and no options', () => {
    renderStrip([askLane({ passedTo: 'Joe', passedAt: now - 120_000 })]);
    const passed = screen.getByTestId('question-passed');
    expect(passed).toHaveTextContent('Passed to Joe');
    // Not pending: this came back from the server, it is not an optimistic guess.
    expect(passed.getAttribute('data-pending')).toBe('false');
    expect(screen.queryByTestId('question-options')).not.toBeInTheDocument();
  });

  it('an ask carrying answeredBy shows the answer and a Confirm that posts it', async () => {
    const { onCommand } = renderStrip([askLane({
      passedTo: 'Joe', passedAt: now - 120_000, answeredBy: 'Joe', text: 'Do we keep the old column?',
      opts: ['Keep it', 'Drop it'],
    })]);
    const answered = screen.getByTestId('question-answered');
    expect(answered).toHaveTextContent('Answered by Joe');
    await userEvent.click(screen.getByTestId('question-confirm'));
    expect(onCommand).toHaveBeenCalledWith('FLT-301', 'answer ask-p Keep it');
  });

  it('the client never sets the passed field itself: with no server field and no click, nothing is passed', () => {
    renderStrip([askLane()]);
    expect(screen.queryByTestId('question-passed')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('question-option')).toHaveLength(2);
  });
});

describe('answering is optimistic too (R-75 item 4)', () => {
  it('advances the strip before the response and clears the mark on it', async () => {
    let settle: (() => void) | null = null;
    const onCommand = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
    const lanes = [
      askLane(),
      lane({
        id: 'FLT-302', stepText: 'second',
        question: { key: 'ask-q', text: 'And this one?', opts: ['Yes', 'No'], askedAt: now - 1_000, recommended: 0, optionSource: 'worker' },
      }),
    ];
    renderStrip(lanes, [], onCommand as CommandFn);
    expect(screen.getByTestId('needs-you-counter')).toHaveTextContent('1 of 2');

    await userEvent.click(screen.getAllByTestId('question-option')[0]!);
    // Before the promise settles the strip has already moved on.
    expect(screen.getByTestId('question-card').textContent).toContain('And this one?');
    expect(screen.getByTestId('needs-you-counter')).toHaveTextContent('2 of 2');
    expect(screen.getByTestId('needs-you-pending')).toBeInTheDocument();

    settle!();
    await waitFor(() => expect(screen.queryByTestId('needs-you-pending')).not.toBeInTheDocument());
  });
});
