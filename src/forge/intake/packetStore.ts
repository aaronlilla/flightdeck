/**
 * One findings packet per ticket, write-once (requirement 2): "a bounded run per unit,
 * nobody re-derives one." A ticket keeps its first packet until something explicit
 * reopens it — a QA fail from Haiping (requirement 10), or a human decision — rather
 * than a second triangulation run silently overwriting the first.
 */
import type { Packet } from '../contracts.js';

export interface PacketWriteResult {
  wrote: boolean;
  reason?: string;
}

export class PacketStore {
  private byTicket = new Map<string, Packet>();

  write(packet: Packet): PacketWriteResult {
    if (this.byTicket.has(packet.ticket)) {
      return { wrote: false, reason: `${packet.ticket} already has a packet; nobody re-derives one` };
    }
    this.byTicket.set(packet.ticket, packet);
    return { wrote: true };
  }

  get(ticket: string): Packet | undefined {
    return this.byTicket.get(ticket);
  }

  /** Clears the way for exactly one new packet — used when a run is legitimately redone. */
  reopen(ticket: string): void {
    this.byTicket.delete(ticket);
  }
}
