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

export function buildPlannerPrompt(packet: Packet): string {
  return [
    'You are Forge Intake\'s planner. One findings packet is queued below. Propose a',
    'goal brief for it: what to fix, its acceptance, nothing that launches anything.',
    '',
    'Packet:',
    JSON.stringify(packet),
    '',
    'The brief you write becomes instructions for a worker agent with no device and no',
    'eyes, so every rule below is fixed, not a suggestion. Verification splits two ways:',
    'the worker verifies whatever a test can reach, and Haiping Chen (QA) verifies',
    'whatever a human eye has to see. Never ask the worker to run on a device or an',
    'emulator, take a screenshot, or confirm something looks right, and never list a',
    'screenshot or a visual check as acceptance or as evidence -- there is no device or',
    'emulator to run one on. Tests are behaviour tests only: @testing-library/react-native',
    'for components, plain unit tests for hooks and pure functions, integration tests at',
    'the API error-contract seam. Never ask for a snapshot test. State every acceptance',
    'criterion so it is observable straight from a tool call in the worker\'s transcript --',
    'a named test file, a file path, an exact string, a status code -- and never phrase one',
    'as "renders cleanly" or "looks right". You cannot read the repository yourself, so',
    'tell the worker to scout the code first and cite file:line for what it found in its',
    'first status update; if the packet above carries a file path or line hint, repeat it',
    'in the brief rather than describing the screen by name. Demand a full, working',
    'implementation -- no stub, mock, placeholder, or hardcoded literal standing in for the',
    'real path. The PR body must carry Haiping\'s visual test plan: every screen the diff',
    'touches, what he should see there, and the sentence that no agent visually verified',
    'it. While iterating, run only the test files the change touches; run the full suite',
    'once at the end. The worker opens a draft PR only -- it never merges, and it never',
    'writes to Jira; that is the pipeline\'s job once the PR lands.',
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
