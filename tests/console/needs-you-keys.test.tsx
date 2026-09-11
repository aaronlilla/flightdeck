// @vitest-environment jsdom
/**
 * R-75 item 3, the adversarial pass. A fresh-context critique of the strip's ordering
 * and key handling on 2026-09-11 found three ways a number key answers something other
 * than what the reader is looking at. Each is a test here.
 *
 * 1. The card on screen was tracked by array position, so a blocker arriving on a poll
 *    sorted to the front and every later card slid down a slot under the reader.
 * 2. A key still answered a card whose options were hidden because it had been passed.
 * 3. A held key or a double click posted the same answer twice and skipped a card.
 *
 * Plus: the number a reader sees must be the option they get, even when the server
 * sends a blank option, and two asks of different kinds must not share pass state.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
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

function asking(id: string, key: string, text: string, opts: string[], askedAt: number): Lane {
  return lane({ id, stepText: 'waiting', question: { key, text, opts, askedAt, recommended: 0, optionSource: 'worker' } as Lane['question'] });
}

function blocker(k: string, what: string, ts: number): Message {
  return {
    k, type: 'blocker', text: what, ts, source: 'FLT-900', lane: 'FLT-900',
    kicker: `Blocked · FLT-900`, title: what, body: 'The agent is parked until it clears.',
    btns: [{ label: 'Open Blockers and clear it', cmd: 'open blockers', cls: 'answer' }],
  };
}

function Harness({ lanes, cards, onCommand }: { lanes: Lane[]; cards: Message[]; onCommand: (id: string, cmd: string) => void | Promise<unknown> }) {
  return <NeedsYou items={buildNeeds(lanes, cards)} now={now} onCommand={onCommand} />;
}

describe('a keypress answers the card on screen and no other (R-75 item 3)', () => {
  it('keeps the reader on their card when a blocker arrives and re-sorts the list', () => {
    const lanes = [
      asking('FLT-401', 'ask-1', 'First question?', ['A one', 'A two'], now - 30_000),
      asking('FLT-402', 'ask-2', 'Second question?', ['B one', 'B two'], now - 20_000),
    ];
    const onCommand = vi.fn();
    const { rerender } = render(<Harness lanes={lanes} cards={[]} onCommand={onCommand} />);

    // The reader moves to the second question.
    fireEvent.click(screen.getByTestId('needs-you-next'));
    expect(screen.getByTestId('question-card').textContent).toContain('Second question?');

    // A poll brings a blocker, which sorts ahead of both questions.
    act(() => { rerender(<Harness lanes={lanes} cards={[blocker('blk-1', 'Sentry is unreachable', now - 1_000)]} onCommand={onCommand} />); });

    // The reader is still on the card they were reading, not on whatever slid into
    // that slot.
    expect(screen.getByTestId('question-card').textContent).toContain('Second question?');
    fireEvent.keyDown(document, { key: '1' });
    expect(onCommand).toHaveBeenCalledWith('FLT-402', 'answer ask-2 B one');
  });

  it('a number key answers nothing once the card has been passed', async () => {
    const onCommand = vi.fn(() => new Promise<never>(() => {}));
    render(<Harness lanes={[asking('FLT-410', 'ask-p', 'Keep the column?', ['Keep it', 'Drop it'], now)]} cards={[]} onCommand={onCommand as never} />);
    await userEvent.click(screen.getByTestId('question-pass'));
    await userEvent.click(screen.getByText('Haiping'));
    expect(screen.getByTestId('question-passed')).toBeInTheDocument();
    expect(screen.queryByTestId('question-options')).not.toBeInTheDocument();

    onCommand.mockClear();
    fireEvent.keyDown(document, { key: '1' });
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('a held key posts one answer, not one per repeat', () => {
    const onCommand = vi.fn();
    render(
      <Harness
        lanes={[
          asking('FLT-420', 'ask-a', 'First?', ['A one', 'A two'], now - 20_000),
          asking('FLT-421', 'ask-b', 'Second?', ['B one', 'B two'], now - 10_000),
        ]}
        cards={[]} onCommand={onCommand}
      />,
    );
    fireEvent.keyDown(document, { key: '1' });
    fireEvent.keyDown(document, { key: '1', repeat: true });
    fireEvent.keyDown(document, { key: '1', repeat: true });
    expect(onCommand).toHaveBeenCalledTimes(1);
    // And the strip advanced by exactly one card.
    expect(screen.getByTestId('needs-you-counter')).toHaveTextContent('2 of 2');
  });

  it('clicking an option twice fast posts it once', async () => {
    const onCommand = vi.fn(() => new Promise<never>(() => {}));
    render(
      <Harness
        lanes={[
          asking('FLT-430', 'ask-a', 'First?', ['A one', 'A two'], now - 20_000),
          asking('FLT-431', 'ask-b', 'Second?', ['B one', 'B two'], now - 10_000),
        ]}
        cards={[]} onCommand={onCommand as never}
      />,
    );
    const option = screen.getAllByTestId('question-option')[0]!;
    fireEvent.click(option);
    fireEvent.click(option);
    expect(onCommand).toHaveBeenCalledTimes(1);
  });

  it('the number a reader sees is the option they get, blank options and all', () => {
    const onCommand = vi.fn();
    render(<Harness lanes={[asking('FLT-440', 'ask-blank', 'Which?', ['   ', 'Keep it', 'Drop it'], now)]} cards={[]} onCommand={onCommand} />);
    const options = screen.getAllByTestId('question-option');
    expect(options).toHaveLength(2);
    expect(options[0]!.textContent).toContain('Keep it');
    fireEvent.keyDown(document, { key: '1' });
    expect(onCommand).toHaveBeenCalledWith('FLT-440', 'answer ask-blank Keep it');
  });

  it('two asks that share an id across kinds do not share pass state', async () => {
    const onCommand = vi.fn(() => new Promise<never>(() => {}));
    // The blocker's own key and the lane question's key are the same string.
    render(
      <Harness
        lanes={[asking('FLT-450', 'same-key', 'Keep the column?', ['Keep it', 'Drop it'], now)]}
        cards={[blocker('same-key', 'Sentry is unreachable', now - 1_000)]}
        onCommand={onCommand as never}
      />,
    );
    // Card 1 is the blocker; it cannot be passed.
    expect(screen.queryByTestId('question-pass')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('needs-you-next'));
    await userEvent.click(screen.getByTestId('question-pass'));
    await userEvent.click(screen.getByText('Joe'));
    expect(screen.getByTestId('question-passed')).toHaveTextContent('Passed to Joe');
    // Back to the blocker: it is not wearing the question's passed state.
    fireEvent.click(screen.getByTestId('needs-you-prev'));
    expect(screen.queryByTestId('question-passed')).not.toBeInTheDocument();
    expect(screen.getByTestId('question-options')).toBeInTheDocument();
  });
});

describe('a number key is inert while a dialog is open (review finding 12)', () => {
  it('does not answer the strip behind an open sheet', () => {
    const onCommand = vi.fn();
    render(
      <>
        <Harness lanes={[asking('FLT-460', 'ask-d', 'Which base?', ['main', 'develop'], now)]} cards={[]} onCommand={onCommand} />
        <div data-testid="sheet-scrim"><button type="button">Close</button></div>
      </>,
    );
    fireEvent.keyDown(document, { key: '1' });
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('answers again once the dialog is gone', () => {
    const onCommand = vi.fn();
    render(<Harness lanes={[asking('FLT-461', 'ask-e', 'Which base?', ['main', 'develop'], now)]} cards={[]} onCommand={onCommand} />);
    fireEvent.keyDown(document, { key: '1' });
    expect(onCommand).toHaveBeenCalledWith('FLT-461', 'answer ask-e main');
  });
});
