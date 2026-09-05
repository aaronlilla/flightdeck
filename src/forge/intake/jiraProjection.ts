/**
 * The Jira projection (requirement 4): what turns a `Packet` into a ticket or a comment,
 * in Aaron's voice, exactly once per external cause.
 *
 * `createFakeJiraSink` is the only Jira Intake's specimens ever talk to — an in-memory
 * map standing in for the real Jira Cloud REST v3 client decision 1 names, which this
 * stream never constructs: the token does not exist yet, and even once it does, no test
 * here is allowed to hold a live connection.
 */
import { withMarker } from './selfWrite.js';
import { voiceGuard } from './voiceGuard.js';
import type { Packet } from '../contracts.js';

export interface FakeJiraSink {
  tickets: Map<string, { key: string; sourceId: string; packet: Packet }>;
  comments: Map<string, string[]>;
}

export function createFakeJiraSink(): FakeJiraSink {
  return { tickets: new Map(), comments: new Map() };
}

let ticketCounter = 0;

/**
 * Creates a ticket for an external finding (a Sentry issue, a CloudWatch alert) unless
 * one already exists for that source id — the idempotency marker decision 1/requirement
 * 5 both ask for. Keyed by the source's own short id rather than by packet id, because a
 * fresh poll rebuilds the packet each time but the underlying finding is the same one.
 */
export async function ensureTicketForFinding(
  jira: FakeJiraSink,
  sourceId: string,
  found: Packet,
): Promise<{ wasCreated: boolean; ticketKey: string }> {
  const existing = [...jira.tickets.values()].find((t) => t.sourceId === sourceId);
  if (existing) return { wasCreated: false, ticketKey: existing.key };
  ticketCounter += 1;
  const key = `BBZ-${9000 + ticketCounter}`;
  jira.tickets.set(key, { key, sourceId, packet: found });
  return { wasCreated: true, ticketKey: key };
}

/**
 * Writes one comment, guarded before the sink is ever touched: `voiceGuard` runs first,
 * and a denial never reaches `jira.comments`. A clean comment gets the hidden operation
 * marker appended (requirement 4's self-write suppression half, `selfWrite.ts`).
 */
export async function writeVoicedComment(
  jira: FakeJiraSink,
  ticketKey: string,
  body: string,
  operationId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const verdict = voiceGuard(body);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  const marked = withMarker(body, operationId);
  const list = jira.comments.get(ticketKey) ?? [];
  list.push(marked);
  jira.comments.set(ticketKey, list);
  return { ok: true };
}
