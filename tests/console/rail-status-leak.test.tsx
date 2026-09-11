// @vitest-environment jsdom
/**
 * R-75 item 1, the escape. The builder's split was green and the rail still drew a
 * refusal: the design-parity screenshot on 2026-09-11 showed a "REFUSED · Could not
 * load machine" card sitting in the Conductor rail, because a card that arrives from
 * the command route is appended to the thread directly and never passes the builder.
 *
 * Two detectors, because one was not enough: the store splits an append the same way
 * the response is split, and the rail filters what it draws whatever it is handed.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ConductorRail } from '../../src/console/components/ConductorRail.js';
import { StoreContext, initialState, reducer } from '../../src/console/store.js';
import { RAIL_TYPES } from '../../src/shared/rail-kinds.js';
import type { Feed, Message, MessageType } from '../../src/shared/console-model.js';

const feedUp: Feed = { live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: Date.now() };

const EVERY_KIND: MessageType[] = [
  'event', 'activity', 'operator', 'reply', 'question', 'plan', 'confirm',
  'receipt', 'refusal', 'pr', 'thinking', 'blocker', 'decision',
];

function row(type: MessageType): Message {
  return { k: `k-${type}`, type, text: `${type} text for the rail`, ts: 1_000, source: 'conductor' };
}

describe('a status card cannot reach the rail by any path (R-75 item 1)', () => {
  it('the store splits an appended card the same way the thread response is split', () => {
    const state = EVERY_KIND.reduce(
      (acc, type) => reducer(acc, { type: 'thread-append', messages: [row(type)], local: true }),
      initialState(),
    );
    for (const type of EVERY_KIND) {
      const onRail = state.thread.some((m) => m.type === type);
      const inCards = state.cards.some((m) => m.type === type);
      expect(onRail, `${type} on the rail`).toBe(RAIL_TYPES.has(type));
      expect(inCards, `${type} in cards`).toBe(!RAIL_TYPES.has(type));
    }
  });

  it('the rail draws none of them even when handed every kind directly', () => {
    render(
      <StoreContext.Provider value={{ state: { ...initialState(), links: { jiraSite: null, defaultRepo: null } }, dispatch: vi.fn() }}>
        <ConductorRail
          thread={EVERY_KIND.map(row)} feed={feedUp} now={Date.now()} composer="" onComposerChange={vi.fn()}
          onSend={vi.fn()} onCommand={vi.fn()} onUndo={vi.fn()} onOpenJournal={vi.fn()}
        />
      </StoreContext.Provider>,
    );
    // The exact card from the screenshot: a refusal, rendered as an action card.
    expect(screen.queryByTestId('card-refusal')).not.toBeInTheDocument();
    for (const type of EVERY_KIND.filter((t) => !RAIL_TYPES.has(t))) {
      expect(screen.queryByTestId(`card-${type}`), `card-${type} is in the rail`).not.toBeInTheDocument();
    }
    expect(screen.queryByTestId('question-card')).not.toBeInTheDocument();
    // And conversation still renders.
    expect(screen.getByText('operator text for the rail')).toBeInTheDocument();
  });
});
