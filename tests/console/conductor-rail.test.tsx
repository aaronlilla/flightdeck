// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConductorRail, QUICK_COMMANDS } from '../../src/console/components/ConductorRail.js';
import { StoreContext, initialState } from '../../src/console/store.js';
import type { Feed, Message } from '../../src/shared/console-model.js';

const feedUp: Feed = { live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: Date.now() };
const feedDown: Feed = { live: false, lostAt: Date.now(), reason: 'the fleet server is unreachable', retryInS: 5, lastHeartbeatAt: null };

function renderRail(thread: Message[], feed: Feed = feedUp, overrides: Partial<{
  onSend: (text: string) => void;
  onCommand: (text: string) => void;
  onOpenJournal: (jid: string) => void;
  verbose: boolean;
  labelFor: (id: string) => string | null;
}> = {}) {
  const onSend = overrides.onSend ?? vi.fn();
  const onCommand = overrides.onCommand ?? vi.fn();
  const onOpenJournal = overrides.onOpenJournal ?? vi.fn();
  const state = { ...initialState(), links: { jiraSite: null, defaultRepo: null } };
  const result = render(
    <StoreContext.Provider value={{ state, dispatch: vi.fn() }}>
      <ConductorRail
        thread={thread} feed={feed} now={Date.now()} composer="" verbose={overrides.verbose ?? false}
        onComposerChange={vi.fn()} onSend={onSend} onCommand={onCommand}
        onUndo={vi.fn()} onOpenJournal={onOpenJournal} labelFor={overrides.labelFor}
      />
    </StoreContext.Provider>,
  );
  return { onSend, onCommand, onOpenJournal, unmount: result.unmount };
}

describe('ConductorRail', () => {
  it('renders a confirm card and routes Confirm through onCommand, never echoing an operator bubble', async () => {
    const { onCommand, onSend } = renderRail([{ k: 'c1', type: 'confirm', text: 'Kill FLT-1?', ts: Date.now(), source: 'console', blast: 'discards the diff.' }]);
    expect(screen.getByText('Confirm — irreversible')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Confirm'));
    expect(onCommand).toHaveBeenCalledWith('confirm c1');
    expect(onSend).not.toHaveBeenCalled();
  });

  // A server round-trip confirm card (from typing "kill <lane>" into the composer)
  // carries the real token in its own `btns`, not in `message.k` -- see
  // `src/forge/console/command.ts`'s `confirmCard`. Confirm/Not now must send that
  // token, not a fallback built off the card's own `k`.
  it('routes a btns-carrying confirm card through its own token, not message.k', async () => {
    const onCommand = vi.fn();
    renderRail([{
      k: 'card-k-not-the-token', type: 'confirm', text: 'confirm?', ts: Date.now(), source: 'conductor', blast: 'kills FLT-1.',
      btns: [
        { label: 'Confirm', cmd: 'confirm real-token-1', cls: 'destroy' },
        { label: 'Not now', cmd: 'dismiss real-token-1' },
      ],
    }], feedUp, { onCommand });
    await userEvent.click(screen.getByText('Confirm'));
    expect(onCommand).toHaveBeenCalledWith('confirm real-token-1');
    onCommand.mockClear();
    await userEvent.click(screen.getByText('Not now'));
    expect(onCommand).toHaveBeenCalledWith('dismiss real-token-1');
  });

  it('routes a btns-carrying plan card through its own token, not message.k', async () => {
    const onCommand = vi.fn();
    renderRail([{
      k: 'plan-k-not-the-token', type: 'plan', text: 'plan', ts: Date.now(), source: 'conductor',
      items: [{ text: 'merge FLT-1', irreversible: true }],
      btns: [
        { label: 'Run plan', cmd: 'run real-plan-token', cls: 'go' },
        { label: 'Not now', cmd: 'dismiss real-plan-token' },
      ],
    }], feedUp, { onCommand });
    await userEvent.click(screen.getByText('Run plan →'));
    expect(onCommand).toHaveBeenCalledWith('run real-plan-token');
    onCommand.mockClear();
    await userEvent.click(screen.getByText('Not now'));
    expect(onCommand).toHaveBeenCalledWith('dismiss real-plan-token');
  });

  it('defaults an unresolved confirm card status to "awaiting you"', () => {
    renderRail([{ k: 'c1', type: 'confirm', text: 'Kill FLT-1?', ts: Date.now(), source: 'console', blast: 'discards the diff.' }]);
    expect(screen.getByText('awaiting you')).toBeInTheDocument();
  });

  it('defaults an unresolved plan card status to "awaiting go"', () => {
    renderRail([{ k: 'p1', type: 'plan', text: 'plan', ts: Date.now(), source: 'console', items: [{ text: 'do it', irreversible: false }] }]);
    expect(screen.getByText('awaiting go')).toBeInTheDocument();
  });

  it('renders a question card and routes a picked option through onCommand on Send, never echoing an operator bubble', async () => {
    const { onCommand, onSend } = renderRail([{
      k: 'q1', type: 'question', text: 'NOT NULL or nullable?', ts: Date.now(), source: 'FLT-1',
      askKey: 'ask-1', opts: ['NOT NULL', 'nullable'], recommended: null,
    }]);
    await userEvent.click(screen.getByText('NOT NULL'));
    await userEvent.click(screen.getByTestId('question-send'));
    expect(onCommand).toHaveBeenCalledWith('answer ask-1 NOT NULL');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('stacks long options one per row and lets their text wrap instead of running off the rail (2026-09-08)', () => {
    const long = 'Close this queue-brief ticket as a misroute with no changes, since the brief was written for a hand session and the queue launched it elsewhere';
    renderRail([{
      k: 'q2', type: 'question', text: 'How should this ticket be closed out?', ts: Date.now(), source: 'FLT-2',
      askKey: 'ask-2', opts: [long, 'Rebase onto origin/main and continue'], recommended: null,
    }]);
    const list = screen.getByTestId('question-options') as HTMLElement;
    expect(list.style.flexDirection).toBe('column');
    const option = screen.getByText(long).closest('label') as HTMLElement;
    expect(option.style.width).toBe('100%');
    expect(option.style.overflowWrap).toBe('anywhere');
  });

  it('shows the answered state once a question carries an answer', () => {
    renderRail([{
      k: 'q1', type: 'question', text: 'NOT NULL or nullable?', ts: Date.now(), source: 'FLT-1',
      askKey: 'ask-1', opts: ['NOT NULL'], answer: 'NOT NULL',
    }]);
    expect(screen.getByText('answered: NOT NULL')).toBeInTheDocument();
  });

  it('disables the composer and shows the reason banner when the feed is down', () => {
    renderRail([], feedDown);
    expect(screen.queryByPlaceholderText(/command…/)).not.toBeInTheDocument();
    expect(screen.getByText(/Composer disabled/)).toBeInTheDocument();
  });

  it('sends the composer text on Enter, echoing through onSend', async () => {
    const onSend = vi.fn();
    const state = { ...initialState(), links: { jiraSite: null, defaultRepo: null } };
    render(
      <StoreContext.Provider value={{ state, dispatch: vi.fn() }}>
        <ConductorRail
          thread={[]} feed={feedUp} now={Date.now()} composer="status" onComposerChange={vi.fn()}
          onSend={onSend} onCommand={vi.fn()} onUndo={vi.fn()} onOpenJournal={vi.fn()}
        />
      </StoreContext.Provider>,
    );
    await userEvent.type(screen.getByPlaceholderText(/command…/), '{Enter}');
    expect(onSend).toHaveBeenCalledWith('status');
  });

  describe('quick commands', () => {
    it('restores the exact four prototype chips in order, each echoing its mapped command through onSend', async () => {
      expect(QUICK_COMMANDS.map(([label]) => label)).toEqual(['pause all', "what's stuck", 'spend today', 'merge ready lanes']);
      const { onSend } = renderRail([]);
      await userEvent.click(screen.getByText('pause all'));
      expect(onSend).toHaveBeenCalledWith('pause everything');
    });
  });

  describe('receipt', () => {
    it('opens the journal sheet for the receipt jid on click, and shows a hover tooltip, in verbose mode', async () => {
      const { onOpenJournal } = renderRail(
        [{ k: 'r1', type: 'receipt', text: 'paused FLT-187', ts: Date.now(), source: 'console', jid: 'J-40217', undoable: true }],
        feedUp, { verbose: true },
      );
      const jidLink = screen.getByText('J-40217');
      await userEvent.click(jidLink);
      expect(onOpenJournal).toHaveBeenCalledWith('J-40217');
      await userEvent.hover(jidLink);
      expect(screen.getByText(/reversible, undo 24h/)).toBeInTheDocument();
    });

    // Item 7: in plain mode the J-xxxx text is hidden -- the receipt's own sentence
    // is the visible text -- but the undo link and the click-to-journal target stay.
    it('hides the jid text in plain mode, keeping the undo link and the click target', async () => {
      const { onOpenJournal } = renderRail(
        [{ k: 'r1', type: 'receipt', text: 'paused FLT-187', ts: Date.now(), source: 'console', jid: 'J-40217', undoable: true }],
        feedUp, { verbose: false },
      );
      expect(screen.queryByText('J-40217')).not.toBeInTheDocument();
      expect(screen.getByText('paused FLT-187')).toBeInTheDocument();
      expect(screen.getByText('undo')).toBeInTheDocument();
      await userEvent.click(screen.getByTestId('receipt-jid'));
      expect(onOpenJournal).toHaveBeenCalledWith('J-40217');
    });

    // Item 13: hiding the jid text left a stray, empty <a> link sitting above every
    // receipt in plain mode. Plain mode renders no anchor for the jid at all -- the
    // click target lives on the receipt's own text instead.
    it('renders no anchor tag for the jid in plain mode, only in verbose', () => {
      renderRail(
        [{ k: 'r1', type: 'receipt', text: 'paused FLT-187', ts: Date.now(), source: 'console', jid: 'J-40217', undoable: true }],
        feedUp, { verbose: false },
      );
      const receiptRow = screen.getByTestId('receipt-jid');
      expect(receiptRow.tagName).not.toBe('A');
      expect(document.querySelectorAll('a[data-testid="receipt-jid"]')).toHaveLength(0);
    });

    it('renders the jid as an anchor tag in verbose mode', () => {
      renderRail(
        [{ k: 'r1', type: 'receipt', text: 'paused FLT-187', ts: Date.now(), source: 'console', jid: 'J-40217', undoable: true }],
        feedUp, { verbose: true },
      );
      expect(screen.getByTestId('receipt-jid').tagName).toBe('A');
    });
  });

  describe('reply label (item 14)', () => {
    it('labels a reply "Conductor" when its source is conductor, console or system', () => {
      for (const source of ['conductor', 'console', 'system']) {
        const { unmount } = renderRail([{ k: `r-${source}`, type: 'reply', text: 'root cause found', ts: Date.now(), source }]);
        expect(screen.getByTestId('reply-label')).toHaveTextContent('Conductor');
        unmount();
      }
    });

    it('labels a reply by its own run, via labelFor, when it came from a worker rather than the conductor', () => {
      renderRail(
        [{ k: 'r1', type: 'reply', text: 'Root cause: the health branch never added its trip id.', ts: Date.now(), source: 'S-b9d39bae548707e0' }],
        feedUp,
        { labelFor: (id) => (id === 'S-b9d39bae548707e0' ? 'BBZ-182' : null) },
      );
      expect(screen.getByTestId('reply-label')).toHaveTextContent('BBZ-182');
    });

    it('falls back to "Worker" when labelFor knows nothing about the reply\'s own source', () => {
      renderRail(
        [{ k: 'r1', type: 'reply', text: 'still working', ts: Date.now(), source: 'S-b9d39bae548707e0' }],
        feedUp,
      );
      expect(screen.getByTestId('reply-label')).toHaveTextContent('Worker');
    });
  });

  describe('reply buttons', () => {
    it('routes a reply button through onCommand, never echoing an operator bubble', async () => {
      const { onCommand, onSend } = renderRail([{
        k: 'r1', type: 'reply', text: 'Recommend kill.', ts: Date.now(), source: 'conductor',
        btns: [{ label: 'Kill attempt', cmd: 'kill FLT-204', cls: 'destroy' }],
      }]);
      await userEvent.click(screen.getByText('Kill attempt'));
      expect(onCommand).toHaveBeenCalledWith('kill FLT-204');
      expect(onSend).not.toHaveBeenCalled();
    });
  });

  describe('pending badge', () => {
    it('counts unresolved confirm, question, and plan cards together as "{n} waiting ↓"', () => {
      renderRail([
        { k: 'c1', type: 'confirm', text: 'Kill?', ts: Date.now(), source: 'console' },
        { k: 'q1', type: 'question', text: 'Which?', ts: Date.now(), source: 'FLT-1', askKey: 'a', opts: ['x'] },
        { k: 'p1', type: 'plan', text: 'plan', ts: Date.now(), source: 'console', items: [] },
        { k: 'q2', type: 'question', text: 'answered', ts: Date.now(), source: 'FLT-1', askKey: 'b', opts: ['x'], answer: 'x' },
      ]);
      expect(screen.getByText('3 waiting ↓')).toBeInTheDocument();
    });

    // Sweep #13: "N waiting" named nothing to jump to.
    it('scrolls to the oldest unresolved card on click', () => {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      renderRail([
        { k: 'e1', type: 'event', text: 'gate opened', ts: 1, source: 'system' },
        { k: 'c1', type: 'confirm', text: 'Kill?', ts: 2, source: 'console' },
        { k: 'q1', type: 'question', text: 'Which?', ts: 3, source: 'FLT-1', askKey: 'a', opts: ['x'] },
      ]);
      fireEvent.click(screen.getByText('2 waiting ↓'));
      expect(scrollIntoView).toHaveBeenCalledOnce();
    });
  });

  describe('thinking', () => {
    it('renders three staggered dots', () => {
      renderRail([{ k: 't1', type: 'thinking', text: '', ts: Date.now(), source: 'conductor' }]);
      const label = screen.getByText('conductor is planning');
      const dots = label.parentElement?.querySelectorAll('span[style*="border-radius: 50%"]');
      expect(dots?.length).toBe(3);
    });
  });

  describe('freshness fallback', () => {
    it('shows a compact ✓/obs stamp on a receipt even without an explicit verifiedAt', () => {
      renderRail([{ k: 'r1', type: 'receipt', text: 'paused FLT-187', ts: Date.now() - 3000, source: 'console', jid: 'J-1', undoable: false }]);
      expect(screen.getByText(/^✓ |^obs /)).toBeInTheDocument();
    });
  });

  // W5: an `event` row is machinery, not conversation -- it moves into the
  // Activity drawer instead of rendering as a chip in the thread itself.
  describe('event row', () => {
    it('never dims an event line in the drawer regardless of freshness', async () => {
      renderRail([{ k: 'e1', type: 'event', text: 'gate opened', ts: Date.now() - 60_000, source: 'system' }], feedUp);
      await userEvent.click(screen.getByTestId('activity-drawer-toggle'));
      const line = screen.getByText(/^gate opened/);
      expect(line.style.opacity).toBe('');
    });
  });

  // Final fidelity sweep #2: the prototype never collapses repeated replies and
  // never caps the thread behind a "show earlier" link -- every message renders,
  // in order, exactly as it arrived.
  describe('full thread rendering', () => {
    it('renders every reply on its own, even three identical ones in a row', () => {
      const reply = (k: string): Message => ({ k, type: 'reply', text: 'still working', ts: 1, source: 'conductor' });
      renderRail([reply('a'), reply('b'), reply('c')]);
      expect(screen.getAllByText('still working')).toHaveLength(3);
      expect(screen.queryByText(/still working ×/)).not.toBeInTheDocument();
    });

    it('renders more than 200 messages with no show earlier link and no cap', async () => {
      const longThread: Message[] = Array.from({ length: 210 }, (_, i) => ({ k: `m${i}`, type: 'event', text: `event ${i}`, ts: i, source: 'system' }));
      renderRail(longThread);
      expect(screen.getByTestId('activity-drawer-badge')).toHaveTextContent('210');
      await userEvent.click(screen.getByTestId('activity-drawer-toggle'));
      expect(screen.getByText(/^event 0/)).toBeInTheDocument();
      expect(screen.getByText(/^event 209/)).toBeInTheDocument();
      expect(screen.queryByText(/show earlier/)).not.toBeInTheDocument();
    });
  });

  // H2.5: a run of warden ticks reads as one chip with a count, not one per tick.
  // W5: the collapsed chip is still an `event` row, so it now lives in the drawer.
  describe('warden ticks', () => {
    it('collapses five consecutive warden ticks into one line', async () => {
      const ticks: Message[] = Array.from({ length: 5 }, (_, i) => ({ k: `w${i}`, type: 'event', text: `tick ${i}`, ts: i, source: 'warden' }));
      renderRail(ticks);
      await userEvent.click(screen.getByTestId('activity-drawer-toggle'));
      expect(screen.getByText(/^warden ×5/)).toBeInTheDocument();
      expect(screen.queryByText('tick 0')).not.toBeInTheDocument();
    });

    it('leaves other events untouched around a warden run', async () => {
      renderRail([
        { k: 'a', type: 'event', text: 'sandbox ready', ts: 0, source: 'system' },
        { k: 'w1', type: 'event', text: 'tick', ts: 1, source: 'warden' },
        { k: 'w2', type: 'event', text: 'tick', ts: 2, source: 'warden' },
        { k: 'b', type: 'event', text: 'gate opened', ts: 3, source: 'system' },
      ]);
      await userEvent.click(screen.getByTestId('activity-drawer-toggle'));
      expect(screen.getByText(/^sandbox ready/)).toBeInTheDocument();
      expect(screen.getByText(/^warden ×2/)).toBeInTheDocument();
      expect(screen.getByText(/^gate opened/)).toBeInTheDocument();
    });
  });

  // Item 7 / W5: an activity digest is machinery too, so it reads as a quiet
  // line in the drawer -- never a chip, and never sitting in the thread itself.
  describe('activity digest', () => {
    it('renders as a quiet line in the drawer, with no chip border', async () => {
      renderRail([{ k: 'a1', type: 'activity', text: 'Worked 16:57 to 17:04: 140 commands, 45 file reads, 11 edits', ts: Date.now(), source: 'FLT-1' }]);
      await userEvent.click(screen.getByTestId('activity-drawer-toggle'));
      const line = screen.getByText(/^Worked 16:57 to 17:04/);
      expect(line).toHaveStyle({ color: 'var(--ink3)' });
      expect(line.className).not.toMatch(/chip/);
    });
  });

  describe('event line wrapping', () => {
    it('wraps a long event sentence instead of clipping it at the drawer edge', async () => {
      const long = 'a lane wide off the reservation deregistered its own worktree and never told the queue';
      renderRail([{ k: 'e1', type: 'event', text: long, ts: Date.now(), source: 'system' }]);
      await userEvent.click(screen.getByTestId('activity-drawer-toggle'));
      const line = screen.getByText(new RegExp(`^${long}`));
      expect(line).toHaveStyle({ overflowWrap: 'anywhere' });
    });
  });

  describe('reply and refusal text', () => {
    it('keeps a multi-line reply\'s own line breaks', () => {
      renderRail([{ k: 'r1', type: 'reply', text: 'line one\nline two', ts: Date.now(), source: 'conductor' }]);
      expect(screen.getByTestId('wrapped-text')).toHaveStyle({ whiteSpace: 'pre-wrap' });
      expect(screen.getByTestId('wrapped-text').textContent).toBe('line one\nline two');
    });

    it('renders a refusal\'s multi-line text with the same pre-wrap treatment, and a leading "- " line as a list item', () => {
      renderRail([{ k: 'f1', type: 'refusal', text: 'refused: the migration is not reversible\n- checked twice', ts: Date.now(), source: 'FLT-1' }]);
      expect(screen.getByTestId('wrapped-text')).toHaveStyle({ whiteSpace: 'pre-wrap' });
      expect(screen.getByText('• checked twice')).toBeInTheDocument();
    });
  });

  describe('question header', () => {
    it('reads "Question from <label>" using the board\'s own labelFor', () => {
      renderRail(
        [{ k: 'q1', type: 'question', text: 'NOT NULL or nullable?', ts: Date.now(), source: 'FLT-1', askKey: 'a', opts: ['x'] }],
        feedUp, { labelFor: (id) => (id === 'FLT-1' ? 'BBZ-118' : null) },
      );
      expect(screen.getByText('Question · from BBZ-118')).toBeInTheDocument();
    });

    it('falls back to the raw source when labelFor knows nothing about it', () => {
      renderRail([{ k: 'q1', type: 'question', text: 'NOT NULL or nullable?', ts: Date.now(), source: 'FLT-1', askKey: 'a', opts: ['x'] }]);
      expect(screen.getByText('Question · from FLT-1')).toBeInTheDocument();
    });
  });
});
