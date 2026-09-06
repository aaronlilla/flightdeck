// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { collapseReplies, ConductorRail } from '../../src/console/components/ConductorRail.js';
import type { Feed, Message } from '../../src/shared/console-model.js';

const feedUp: Feed = { live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: Date.now() };
const feedDown: Feed = { live: false, lostAt: Date.now(), reason: 'the fleet server is unreachable', retryInS: 5, lastHeartbeatAt: null };

function renderRail(thread: Message[], feed: Feed = feedUp, onSend = vi.fn()) {
  render(
    <ConductorRail
      thread={thread} feed={feed} now={Date.now()} composer=""
      onComposerChange={vi.fn()} onSend={onSend} onUndo={vi.fn()}
    />,
  );
  return onSend;
}

describe('ConductorRail', () => {
  it('renders a confirm card and sends confirm <k> when Confirm is clicked', async () => {
    const onSend = renderRail([{ k: 'c1', type: 'confirm', text: 'Kill FLT-1?', ts: Date.now(), source: 'console', blast: 'discards the diff.' }]);
    expect(screen.getByText('Confirm — irreversible')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Confirm'));
    expect(onSend).toHaveBeenCalledWith('confirm c1');
  });

  it('renders a question card and sends an option as an answer', async () => {
    const onSend = renderRail([{
      k: 'q1', type: 'question', text: 'NOT NULL or nullable?', ts: Date.now(), source: 'FLT-1',
      askKey: 'ask-1', opts: ['NOT NULL', 'nullable'],
    }]);
    await userEvent.click(screen.getByText('NOT NULL'));
    expect(onSend).toHaveBeenCalledWith('answer ask-1 NOT NULL');
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

  it('sends the composer text on Enter', async () => {
    const onSend = vi.fn();
    render(
      <ConductorRail thread={[]} feed={feedUp} now={Date.now()} composer="status" onComposerChange={vi.fn()} onSend={onSend} onUndo={vi.fn()} />,
    );
    await userEvent.type(screen.getByPlaceholderText(/command…/), '{Enter}');
    expect(onSend).toHaveBeenCalledWith('status');
  });

  // POLISH-2 #5: a run of identical consecutive conductor replies collapses into one card.
  describe('collapseReplies', () => {
    it('collapses three identical consecutive replies into one card with the count', () => {
      const reply = (k: string): Message => ({ k, type: 'reply', text: 'still working', ts: 1, source: 'conductor' });
      const out = collapseReplies([reply('a'), reply('b'), reply('c')]);
      expect(out).toHaveLength(1);
      expect(out[0]?.collapsedCount).toBe(3);
    });

    it('does not collapse replies with different text, or across a different message type', () => {
      const thread: Message[] = [
        { k: 'a', type: 'reply', text: 'still working', ts: 1, source: 'conductor' },
        { k: 'b', type: 'event', text: 'heartbeat', ts: 2, source: 'system' },
        { k: 'c', type: 'reply', text: 'still working', ts: 3, source: 'conductor' },
        { k: 'd', type: 'reply', text: 'done', ts: 4, source: 'conductor' },
      ];
      expect(collapseReplies(thread)).toHaveLength(4);
    });

    it('renders the ×N suffix on a collapsed reply card', () => {
      const reply = (k: string): Message => ({ k, type: 'reply', text: 'still working', ts: 1, source: 'conductor' });
      renderRail([reply('a'), reply('b'), reply('c')]);
      expect(screen.getByText(/still working ×3/)).toBeInTheDocument();
    });
  });

  // POLISH-2 #5: never render more than the last 200 messages; older ones sit behind "show earlier".
  describe('the 200-message cap', () => {
    function longThread(n: number): Message[] {
      return Array.from({ length: n }, (_, i) => ({ k: `m${i}`, type: 'event', text: `event ${i}`, ts: i, source: 'system' }));
    }

    it('shows only the last 200 messages by default, with a show earlier link', () => {
      renderRail(longThread(210));
      expect(screen.queryByText('event 0')).not.toBeInTheDocument();
      expect(screen.getByText('event 209')).toBeInTheDocument();
      expect(screen.getByText(/show earlier/)).toBeInTheDocument();
    });

    it('reveals the earlier messages once show earlier is clicked', async () => {
      renderRail(longThread(210));
      await userEvent.click(screen.getByText(/show earlier/));
      expect(screen.getByText('event 0')).toBeInTheDocument();
    });

    it('shows no show earlier link at or under 200 messages', () => {
      renderRail(longThread(200));
      expect(screen.queryByText(/show earlier/)).not.toBeInTheDocument();
    });
  });
});
