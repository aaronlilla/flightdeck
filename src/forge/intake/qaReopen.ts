/**
 * Requirement 10: a QA fail is input, not noise. The reviewer's own words become the
 * next round's findings verbatim, and the ticket moves back to In Progress using the
 * BBZ workflow's own transition ids (memory `jira-bbz-workflow-ids.md`) rather than a
 * name a caller could get wrong.
 */
import { PacketStore } from './packetStore.js';

export const BBZ_TRANSITIONS = {
  toBacklog: 11,
  toInProgress: 21,
  toInReviewQa: 31,
  toDone: 41,
  toCancelled: 2,
} as const;

export interface QaReopenResult {
  transition: number;
  newFindings: string[];
}

/**
 * Clears the ticket's existing packet (so exactly one new one can be written — see
 * `PacketStore`), returns the In Progress transition id, and carries the reviewer's
 * words through unmodified: no summarising, no rewording, so nothing this stream does
 * loses what QA actually said.
 */
export function reopenFromQaFail(store: PacketStore, ticket: string, qaWords: string): QaReopenResult {
  store.reopen(ticket);
  return { transition: BBZ_TRANSITIONS.toInProgress, newFindings: [qaWords] };
}
