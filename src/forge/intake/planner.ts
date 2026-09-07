/**
 * `forge intake --once`'s planner: one queued packet through the `Reasoner`, producing a
 * goal brief's text. This module never launches anything and never writes a file itself
 * -- `cli.ts` owns where a brief lands, the same separation `council/attest.ts` keeps
 * from Council's own orchestration. Provider selection is `resolvePlanProvider`'s job
 * (decision 6, the 2026-09-04 16:40 amendment): `claude` unless the policy file's
 * `reasoner.astra` is exactly `'planning-only'`.
 */
import type { Packet, Reasoner } from '../contracts.ts';

export interface PlannedBrief {
  packetId: string;
  ticket: string;
  text: string;
}

function buildPlannerPrompt(packet: Packet): string {
  return [
    'You are Forge Intake\'s planner. One findings packet is queued below. Propose a',
    'goal brief for it: what to fix, its acceptance, nothing that launches anything.',
    '',
    'Packet:',
    JSON.stringify(packet),
    '',
    'Set your `text` field to the full brief as Markdown, starting with a "# Goal:"',
    'heading.',
  ].join('\n');
}

/**
 * One queued packet through the Reasoner. Never writes a file itself.
 *
 * `className` defaults to `'plan'`, unchanged from before this parameter existed. C.2:
 * a pasted brief or a typed hotfix has no ticket to triangulate, so planning it does not
 * need `plan`'s full budget -- the queue's own planner (`queue-wire.ts`'s `queuePlanner`,
 * stream A's file) is where a `brief`/`hotfix` source decides to pass `'triage'` instead;
 * this function only has to accept the choice, never make it.
 */
export async function planFromPacket(packet: Packet, reasoner: Reasoner, className = 'plan'): Promise<PlannedBrief> {
  const prompt = buildPlannerPrompt(packet);
  const result = await reasoner.call({ className, prompt });
  return { packetId: packet.id, ticket: packet.ticket, text: result.text };
}
