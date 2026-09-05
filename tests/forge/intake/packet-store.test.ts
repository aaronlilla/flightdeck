/**
 * Requirement 2 — a bounded triangulation run per unit; nobody re-derives a packet once
 * one exists for a ticket (roadmap:113; spine spec Section 2). `PacketStore` is the
 * boundary that makes re-derivation a refusal rather than a second, silently
 * inconsistent write.
 */
import { describe, expect, it } from 'vitest';

import { PacketStore } from '../../../src/forge/intake/packetStore.js';
import type { Packet } from '../../../src/forge/contracts.js';

function packet(id: string, ticket: string): Packet {
  return {
    id, ticket, what: 'x', where: 'x', evidence: [], confidence: 'low', repo: 'x',
    blockedBy: [], at: 1,
  };
}

describe('PacketStore', () => {
  it('stores the first packet written for a ticket', () => {
    const store = new PacketStore();
    const result = store.write(packet('pkt-1', 'BBZ-1'));
    expect(result.wrote).toBe(true);
    expect(store.get('BBZ-1')?.id).toBe('pkt-1');
  });

  it('refuses a second write for a ticket that already has a packet — nobody re-derives one', () => {
    const store = new PacketStore();
    store.write(packet('pkt-1', 'BBZ-1'));
    const second = store.write(packet('pkt-2', 'BBZ-1'));
    expect(second.wrote).toBe(false);
    expect(second.reason).toMatch(/already has a packet/i);
    expect(store.get('BBZ-1')?.id).toBe('pkt-1');
  });

  it('a ticket can be re-opened explicitly (Haiping QA fail), which clears the way for exactly one new packet', () => {
    const store = new PacketStore();
    store.write(packet('pkt-1', 'BBZ-1'));
    store.reopen('BBZ-1');
    const second = store.write(packet('pkt-2', 'BBZ-1'));
    expect(second.wrote).toBe(true);
    expect(store.get('BBZ-1')?.id).toBe('pkt-2');
  });
});
