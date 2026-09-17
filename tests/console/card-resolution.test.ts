import { describe, expect, it } from 'vitest';

import { applyLocalResolutions, LOCAL_CARD_TTL_MS } from '../../src/console/cardResolution.js';
import type { Message } from '../../src/shared/console-model.js';

/**
 * What a card says after somebody clicked it.
 *
 * The regression this covers, found in review on 2026-09-12: confirming a card SPENDS
 * its token, and the server settles a card whose token is gone as `expired`. So the poll
 * five seconds after a successful kill brought the card back expired, the local "somebody
 * answered this" override was applied only to a card carrying no resolution at all, and
 * the operator watched their own successful confirmation turn into "Expired."
 *
 * The override outranks `expired` and nothing else: a click is the newer and more
 * specific account of what happened to that card.
 */

const NOW = 1_789_200_000_000;

function card(patch: Partial<Message> = {}): Message {
  return { k: 'c1', type: 'confirm', text: 'confirm?', ts: NOW, source: 'conductor', ...patch };
}

describe('a card somebody just clicked', () => {
  const clicked = new Map([['c1', { resolved: 'confirmed' as const, at: NOW }]]);

  it('reads as confirmed even though the server settled it as expired', () => {
    const [out] = applyLocalResolutions([card({ resolved: 'expired' })], clicked, NOW);
    expect(out?.resolved).toBe('confirmed');
  });

  it('reads as confirmed when the server has said nothing yet', () => {
    const [out] = applyLocalResolutions([card()], clicked, NOW);
    expect(out?.resolved).toBe('confirmed');
  });

  it('does not overwrite a different resolution the server already reported', () => {
    const [out] = applyLocalResolutions([card({ resolved: 'declined' })], clicked, NOW);
    expect(out?.resolved).toBe('declined');
  });

  it('leaves a card nobody clicked exactly as the server sent it', () => {
    const [out] = applyLocalResolutions([card({ k: 'other', resolved: 'expired' })], clicked, NOW);
    expect(out?.resolved).toBe('expired');
  });

  it('lets the server have the card back once the override ages out', () => {
    const old = new Map([['c1', { resolved: 'confirmed' as const, at: NOW - LOCAL_CARD_TTL_MS - 1 }]]);
    const [out] = applyLocalResolutions([card({ resolved: 'expired' })], old, NOW);
    expect(out?.resolved).toBe('expired');
    expect(old.size).toBe(0);
  });

  it('returns the same array when nothing is overridden, so the page does not re-render', () => {
    const messages = [card()];
    expect(applyLocalResolutions(messages, new Map(), NOW)).toBe(messages);
  });
});
