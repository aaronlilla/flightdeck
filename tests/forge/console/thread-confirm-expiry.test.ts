import { describe, expect, it } from 'vitest';

import { computeThread } from '../../../src/forge/console/thread.js';
import { CONFIRM_TTL_MS, type Message } from '../../../src/shared/console-model.js';

/**
 * A confirm nobody can answer is not an ask.
 *
 * The escape this covers, found live on 2026-09-12: the console's Needs-you strip
 * offered 67 confirm cards, every one of them titled `confirm?`, the oldest 122 hours
 * old. The durable token store held 12 rows and every one of the 12 was already past its
 * two-hour life, so not one of the 67 could be answered by anyone. A confirm card is
 * rebuilt from its `conductor.receipt` journal row on every read and the row is
 * permanent, so the card outlived its token by days.
 *
 * The strip filters on `resolved`, so settling a dead confirm there takes it out of the
 * asks while leaving it in the history where a person can still look back at it.
 */

const NOW = 1_789_200_000_000;

function confirmRow(k: string, token: string, at: number): Message {
  return {
    k, type: 'confirm', text: 'confirm?', ts: at, source: 'conductor',
    blast: 'BBZ-182 is killed immediately; its worktree and process are gone',
    btns: [
      { label: 'Confirm', cmd: `confirm ${token}`, cls: 'destroy' },
      { label: 'Not now', cmd: `dismiss ${token}` },
    ],
  };
}

function cardsFrom(persisted: Message[], options: Parameters<typeof computeThread>[5] = {}): Message[] {
  return computeThread(persisted, [], NOW, [], () => null, options).cards;
}

describe('a confirm card outliving its token', () => {
  it('is settled as expired once no pending token answers it', () => {
    const cards = cardsFrom([confirmRow('c1', 'gone', NOW - 5 * 60_000)], { confirmPending: () => false });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.resolved).toBe('expired');
  });

  it('is left alone while its token is still pending, however old the card is', () => {
    // The in-memory half of the pending map has no lifetime of its own, so a long-lived
    // process can still answer a card older than the durable store's own TTL. The
    // predicate is the authority; age is not.
    const cards = cardsFrom([confirmRow('c1', 'live', NOW - 50 * CONFIRM_TTL_MS)], { confirmPending: () => true });
    expect(cards[0]?.resolved).toBeUndefined();
  });

  it('keeps a confirm a person already answered exactly as it was', () => {
    const answered: Message = { ...confirmRow('c1', 'gone', NOW - 5 * 60_000), resolved: 'confirmed' };
    expect(cardsFrom([answered], { confirmPending: () => false })[0]?.resolved).toBe('confirmed');
  });

  it('leaves a confirm that carries no Confirm button alone', () => {
    const noButton: Message = { k: 'c1', type: 'confirm', text: 'confirm?', ts: NOW, source: 'conductor', btns: [] };
    expect(cardsFrom([noButton], { confirmPending: () => false })[0]?.resolved).toBeUndefined();
  });

  it('touches nothing but confirms', () => {
    const question: Message = { k: 'q1', type: 'question', text: 'Build it here?', ts: NOW - 5 * CONFIRM_TTL_MS, source: 'item:Q-1', opts: ['Yes', 'No'] };
    expect(cardsFrom([question], { confirmPending: () => false })[0]?.resolved).toBeUndefined();
  });

  describe('with no predicate wired — a specimen, or a test', () => {
    it('falls back to the token lifetime and settles a card past it', () => {
      expect(cardsFrom([confirmRow('c1', 'gone', NOW - CONFIRM_TTL_MS - 1)])[0]?.resolved).toBe('expired');
    });

    it('leaves a card inside that window alone, since an in-memory token may be live', () => {
      expect(cardsFrom([confirmRow('c1', 'maybe', NOW - 60_000)])[0]?.resolved).toBeUndefined();
    });
  });
});
