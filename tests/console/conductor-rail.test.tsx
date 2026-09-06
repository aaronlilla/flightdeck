// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConductorRail, QUICK_COMMANDS } from '../../src/console/components/ConductorRail.js';
import type { Feed, Message } from '../../src/shared/console-model.js';

const feedUp: Feed = { live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: Date.now() };
const feedDown: Feed = { live: false, lostAt: Date.now(), reason: 'the fleet server is unreachable', retryInS: 5, lastHeartbeatAt: null };

function renderRail(thread: Message[], feed: Feed = feedUp, overrides: Partial<{
  onSend: (text: string) => void;
  onCommand: (text: string) => void;
  onOpenJournal: (jid: string) => void;
}> = {}) {
  const onSend = overrides.onSend ?? vi.fn();
  const onCommand = overrides.onCommand ?? vi.fn();
  const onOpenJournal = overrides.onOpenJournal ?? vi.fn();
  render(
    <ConductorRail
      thread={thread} feed={feed} now={Date.now()} composer=""
      onComposerChange={vi.fn()} onSend={onSend} onCommand={onCommand}
      onUndo={vi.fn()} onOpenJournal={onOpenJournal}
    />,
  );
  return { onSend, onCommand, onOpenJournal };
}

describe('ConductorRail', () => {
  it('renders a confirm card and routes Confirm through onCommand, never echoing an operator bubble', async () => {
    const { onCommand, onSend } = renderRail([{ k: 'c1', type: 'confirm', text: 'Kill FLT-1?', ts: Date.now(), source: 'console', blast: 'discards the diff.' }]);
    expect(screen.getByText('Confirm — irreversible')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Confirm'));
    expect(onCommand).toHaveBeenCalledWith('confirm c1');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('defaults an unresolved confirm card status to "awaiting you"', () => {
    renderRail([{ k: 'c1', type: 'confirm', text: 'Kill FLT-1?', ts: Date.now(), source: 'console', blast: 'discards the diff.' }]);
    expect(screen.getByText('awaiting you')).toBeInTheDocument();
  });

  it('defaults an unresolved plan card status to "awaiting go"', () => {
    renderRail([{ k: 'p1', type: 'plan', text: 'plan', ts: Date.now(), source: 'console', items: [{ text: 'do it', irreversible: false }] }]);
    expect(screen.getByText('awaiting go')).toBeInTheDocument();
  });

  it('renders a question card and routes an option click through onCommand, never echoing an operator bubble', async () => {
    const { onCommand, onSend } = renderRail([{
      k: 'q1', type: 'question', text: 'NOT NULL or nullable?', ts: Date.now(), source: 'FLT-1',
      askKey: 'ask-1', opts: ['NOT NULL', 'nullable'],
    }]);
    await userEvent.click(screen.getByText('NOT NULL'));
    expect(onCommand).toHaveBeenCalledWith('answer ask-1 NOT NULL');
    expect(onSend).not.toHaveBeenCalled();
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
    render(
      <ConductorRail
        thread={[]} feed={feedUp} now={Date.now()} composer="status" onComposerChange={vi.fn()}
        onSend={onSend} onCommand={vi.fn()} onUndo={vi.fn()} onOpenJournal={vi.fn()}
      />,
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
    it('opens the journal sheet for the receipt jid on click, and shows a hover tooltip', async () => {
      const { onOpenJournal } = renderRail([{ k: 'r1', type: 'receipt', text: 'paused FLT-187', ts: Date.now(), source: 'console', jid: 'J-40217', undoable: true }]);
      const jidLink = screen.getByText('J-40217');
      await userEvent.click(jidLink);
      expect(onOpenJournal).toHaveBeenCalledWith('J-40217');
      await userEvent.hover(jidLink);
      expect(screen.getByText(/reversible, undo 24h/)).toBeInTheDocument();
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

  describe('event row', () => {
    it('never dims an event chip regardless of freshness', () => {
      renderRail([{ k: 'e1', type: 'event', text: 'gate opened', ts: Date.now() - 60_000, source: 'system' }], feedUp);
      const chip = screen.getByText('gate opened');
      const row = chip.parentElement as HTMLElement;
      expect(row.style.opacity).toBe('');
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

    it('renders more than 200 messages with no show earlier link and no cap', () => {
      const longThread: Message[] = Array.from({ length: 210 }, (_, i) => ({ k: `m${i}`, type: 'event', text: `event ${i}`, ts: i, source: 'system' }));
      renderRail(longThread);
      expect(screen.getByText('event 0')).toBeInTheDocument();
      expect(screen.getByText('event 209')).toBeInTheDocument();
      expect(screen.queryByText(/show earlier/)).not.toBeInTheDocument();
    });
  });
});
