/**
 * Requirement 10 — QA comments are input: a QA fail reopens the run with the reviewer's
 * own words as findings; Jira transitions use the BBZ workflow ids on record (memory
 * `jira-bbz-workflow-ids.md`): Backlog 10036 (transition 11), In Progress 10037 (21),
 * In Review/QA 10038 (31), Done 10039 (41), Cancelled 10041 (2).
 */
import { describe, expect, it } from 'vitest';

import { BBZ_TRANSITIONS, reopenFromQaFail } from '../../../src/forge/intake/qaReopen.js';
import { PacketStore } from '../../../src/forge/intake/packetStore.js';
import type { Packet } from '../../../src/forge/contracts.js';

function packet(id: string, ticket: string): Packet {
  return { id, ticket, what: 'x', where: 'x', evidence: [], confidence: 'low', repo: 'x', blockedBy: [], at: 1 };
}

describe('BBZ_TRANSITIONS — the ids on record', () => {
  it('names every transition id exactly as recorded', () => {
    expect(BBZ_TRANSITIONS).toEqual({
      toBacklog: 11, toInProgress: 21, toInReviewQa: 31, toDone: 41, toCancelled: 2,
    });
  });
});

describe('reopenFromQaFail', () => {
  it('a QA fail clears the packet, transitions back to In Progress, and files the reviewer\'s words as new evidence', () => {
    const store = new PacketStore();
    store.write(packet('pkt-1', 'BBZ-1'));
    const result = reopenFromQaFail(store, 'BBZ-1', 'crashes on cold start with airplane mode on');
    expect(result.transition).toBe(BBZ_TRANSITIONS.toInProgress);
    expect(result.newFindings).toEqual(['crashes on cold start with airplane mode on']);
    expect(store.get('BBZ-1')).toBeUndefined();
  });

  it('the reviewer\'s exact words survive verbatim as findings — never summarised or reworded', () => {
    const store = new PacketStore();
    store.write(packet('pkt-2', 'BBZ-2'));
    const words = 'the button is 4px off center on the small-screen layout, not a crash but still wrong';
    const result = reopenFromQaFail(store, 'BBZ-2', words);
    expect(result.newFindings[0]).toBe(words);
  });
});
