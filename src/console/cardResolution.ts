import type { Message } from '../shared/console-model.js';
import { LOCAL_CARD_TTL_MS } from './store.js';

/**
 * What a card says after somebody clicked it, while the server catches up.
 *
 * Lifted out of `App.tsx` so it can be tested without mounting the page. The rule it
 * holds is small and was wrong in a way no rendering test would have caught: confirming
 * a card SPENDS its token, and the server settles a card whose token is gone as
 * `expired`, so the poll five seconds after a successful kill brought the card back
 * expired and the operator watched their own confirmation turn into "Expired."
 * (found in review, 2026-09-12).
 */

/** How long the page remembers a click the server has not reflected yet. Re-exported
 *  from the store, which already owns it, so the two cannot drift apart. */
export { LOCAL_CARD_TTL_MS };

export interface LocalResolution {
  resolved: 'confirmed' | 'declined';
  at: number;
}

/**
 * Applies what this page knows about cards somebody clicked here, over what the server
 * sent. Prunes overrides past their life as it goes, and returns the input array
 * untouched when there is nothing to apply, so an unchanged poll does not re-render.
 *
 * The override outranks `expired` and nothing else. `expired` is the server saying the
 * token is gone, and a click is exactly what takes it, so a click is the newer and more
 * specific account of what happened to that card. Every other resolution the server
 * reports is its own and stands.
 */
export function applyLocalResolutions(
  messages: Message[], overrides: Map<string, LocalResolution>, now: number,
): Message[] {
  const cutoff = now - LOCAL_CARD_TTL_MS;
  for (const [key, override] of [...overrides]) {
    if (override.at < cutoff) overrides.delete(key);
  }
  if (overrides.size === 0) return messages;
  return messages.map((message) => {
    const override = overrides.get(message.k);
    const stale = message.resolved === undefined || message.resolved === 'expired';
    return override && stale ? { ...message, resolved: override.resolved } : message;
  });
}
