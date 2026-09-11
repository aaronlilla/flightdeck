import type { MessageType } from './console-model.js';

/**
 * R-75 item 1 (spec `doctrine/design/operator-experience.md` §3). Aaron, 2026-09-11:
 * "the chat needs to be much more readable and usable without the constant verbose
 * spam." Status left the chat.
 *
 * The rail carries conversation: what a person said (`operator`), what came back
 * (`reply`), and the receipt for what ran (`receipt`). `event` and `activity` ride the
 * same list because the rail's closed Activity drawer reads them off it and draws them
 * nowhere else. Every other kind is status, and reaches the console through the thread
 * response's `cards` field instead.
 *
 * One list, three readers: the thread builder splits on it, the stub server answers the
 * same shape, and the rail itself filters on it so a card appended by any other path --
 * a refusal from the command route, a local card the page put up -- still cannot land
 * in the conversation.
 *
 * Deliberately free of imports beyond the type: the browser bundle loads this, so it
 * must never pull in the server's own modules.
 */
export const RAIL_TYPES: ReadonlySet<MessageType> = new Set<MessageType>([
  'operator', 'reply', 'receipt', 'event', 'activity',
]);

export function isRailKind(type: MessageType): boolean {
  return RAIL_TYPES.has(type);
}
